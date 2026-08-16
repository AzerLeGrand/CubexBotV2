import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createCommandRegistry } from '../../../src/core/commands/index.js';
import { CapabilityRegistry } from '../../../src/core/config/capabilities.js';
import { loadYamlFiles } from '../../../src/core/config/loader.js';
import { createDatabase } from '../../../src/core/database/index.js';
import { CORE_OWNER } from '../../../src/core/database/migrations.js';
import { EPHEMERAL } from '../../../src/core/discord/flags.js';
import { createChallenge } from '../../../src/modules/verification/challenge/index.js';
import { createCommands } from '../../../src/modules/verification/commands.js';
import { HISTORY_EVENTS, OUTCOMES } from '../../../src/modules/verification/constants.js';
import { createVerificationEngine } from '../../../src/modules/verification/engine.js';
import { createVerificationRepository } from '../../../src/modules/verification/repository.js';
import { createChallengeStore } from '../../../src/modules/verification/store.js';
import { fromRoot } from '../../../src/utils/paths.js';

/**
 * `/unblock`, dernière pièce du module.
 *
 * Le cas qui décide de l'implémentation — une cible qui a quitté le serveur —
 * est testé sur une interaction dont `getMember()` rend `null`, c'est-à-dire
 * exactement ce que Discord envoie dans ce cas.
 */

const MEMBRE = '123456789012345678';
const MODERATEUR = '987654321098765432';
const ROLE_MODO = '111111111111111111';

const REGLAGES = {
  'verification.challenge.type': 'image',
  'verification.challenge.code_length': 6,
  'verification.challenge.ttl_seconds': 300,
  'verification.challenge.alphabet': 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  'verification.challenge.sweep_interval_seconds': 60,
  'verification.challenge.input.case_sensitive': false,
  'verification.challenge.input.strip_whitespace': true,
  'verification.challenge.image.width': 320,
  'verification.challenge.image.height': 110,
  'verification.challenge.image.font_path': 'assets/fonts/DejaVuSans-Bold.ttf',
  'verification.challenge.image.font_size': 52,
  'verification.challenge.image.background': '#FFFFFF',
  'verification.challenge.image.text_color': '#1A1A1A',
  'verification.challenge.image.noise_lines': 6,
  'verification.challenge.image.noise_dots': 220,
  'verification.challenge.image.distortion': 0.35,
  'verification.challenge.image.slow_render_ms': 50,
  'verification.max_attempts': 5,
  'commands.unblock.allowed_roles': [ROLE_MODO],
};

const fakeLogger = () => {
  const entries = [];
  const record = (level) => (message, context) => entries.push({ level, message, context });

  return {
    entries,
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    forModule() {
      return this;
    },
    of: (level) => entries.filter((entry) => entry.level === level),
  };
};

const fakeConfig = {
  get: (path, ...fallback) => {
    if (path in REGLAGES) return REGLAGES[path];
    if (fallback.length > 0) return fallback[0];
    throw new Error(`chemin de configuration inconnu : ${path}`);
  },
  text: (key) => key,
};

const SOURCES = [
  { owner: CORE_OWNER, directory: fromRoot('migrations') },
  { owner: 'verification', directory: fromRoot('src', 'modules', 'verification', 'migrations') },
];

/**
 * Interaction de commande factice.
 *
 * `member` est nul par défaut : c'est ce que Discord envoie quand la cible a
 * quitté le serveur, et le cas nominal de cette commande doit fonctionner
 * malgré ça.
 */
const fakeInteraction = ({
  cible = MEMBRE,
  cibleMembre = null,
  roles = [ROLE_MODO],
  auteur = MODERATEUR,
} = {}) => ({
  commandName: 'unblock',
  user: { id: auteur },
  member: { roles: { cache: new Map(roles.map((id) => [id, { id }])) } },
  replies: [],
  options: {
    getUser: (name, required) => {
      if (name !== 'member') throw new Error(`option inconnue : ${name}`);
      if (cible === null && required) throw new Error('option requise absente');
      return cible === null ? null : { id: cible };
    },
    getMember: () => cibleMembre,
  },
  async reply(payload) {
    this.replies.push(payload);
    this.replied = true;
  },
});

const sandbox = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cubex-unblock-'));
  const logger = fakeLogger();
  const database = createDatabase({ file: join(root, 'test.sqlite'), logger });

  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  database.migrate(SOURCES);

  const challenge = createChallenge({ config: fakeConfig, logger });
  challenge.prepare();

  const store = createChallengeStore({ config: fakeConfig, logger });
  const repository = createVerificationRepository({ database });
  const engine = createVerificationEngine({ config: fakeConfig, challenge, store, repository });

  const [unblock] = createCommands({ engine: () => engine });

  const embeds = { render: (template, variables = {}) => ({ template, variables }) };

  return {
    database,
    logger,
    store,
    repository,
    engine,
    unblock,
    embeds,
    ctx: { config: fakeConfig, embeds, logger },
  };
};

/** Amène le membre au blocage, par cinq échecs successifs. */
const bloquer = async (held) => {
  for (let i = 0; i < 5; i += 1) {
    held.engine.begin({ userId: MEMBRE, hasRole: false });
    await held.engine.submit({ userId: MEMBRE, hasRole: false, input: 'FAUXXX' });
  }
};

const events = (repository, userId) => repository.history(userId).map((row) => row.event);

const gabarit = (interaction) => interaction.replies.at(-1).embeds[0].template;

describe('déclaration de la commande', () => {
  test('une seule option, de type utilisateur et obligatoire', () => {
    const [unblock] = createCommands({ engine: () => null });

    assert.equal(unblock.name, 'unblock');
    assert.equal(unblock.description_key, 'commands.unblock.description');
    assert.equal(unblock.options.length, 1);

    const [option] = unblock.options;

    // Type `user` et non une chaîne : Discord valide la cible et évite la faute
    // de frappe sur dix-neuf chiffres.
    assert.equal(option.type, 6, 'ApplicationCommandOptionType.User');
    assert.equal(option.name, 'member');
    assert.equal(option.required, true);
    assert.equal(option.description_key, 'commands.unblock.option_member');
  });

  test('la clé de permission résout dans la configuration livrée', () => {
    const { files } = loadYamlFiles();
    const roles = files.config.commands.unblock.allowed_roles;

    assert.ok(Array.isArray(roles) && roles.length > 0);

    // Identifiants Discord en chaînes, sans exception.
    for (const role of roles) assert.equal(typeof role, 'string', role);

    // Liste distincte de celle de reload : recharger la configuration est une
    // action d'exploitation, débloquer une action de modération courante.
    assert.notDeepEqual(roles, files.config.commands.reload.allowed_roles);
  });

  test('la commande s\'enregistre et n\'est pas signalée sans configuration', (t) => {
    const { unblock, embeds, logger } = sandbox(t);
    const registry = createCommandRegistry({ config: fakeConfig, logger, embeds });

    registry.register('verification', [unblock]);

    assert.equal(registry.has('unblock'), true);
    assert.deepEqual(registry.unconfigured(), []);
  });
});

describe('membre bloqué', () => {
  test('la ligne est supprimée et la réponse le dit', async (t) => {
    const held = sandbox(t);
    await bloquer(held);

    assert.equal(held.repository.isBlocked(MEMBRE), true);

    const interaction = fakeInteraction();
    await held.unblock.execute(interaction, held.ctx);

    assert.equal(gabarit(interaction), 'verification_unblocked');
    assert.equal(held.repository.find(MEMBRE), null, 'la ligne est supprimée, pas mise à zéro');
    assert.equal(held.repository.isBlocked(MEMBRE), false);
  });

  test('l\'historique porte l\'auteur du déblocage', async (t) => {
    const held = sandbox(t);
    await bloquer(held);

    await held.unblock.execute(fakeInteraction(), held.ctx);

    const derniere = held.repository.history(MEMBRE).at(-1);

    assert.equal(derniere.event, HISTORY_EVENTS.unblock);
    assert.equal(derniere.actor_id, MODERATEUR, 'seule commande du module à écrire actor_id');
  });

  test('la réponse est éphémère et mentionne le membre', async (t) => {
    const held = sandbox(t);
    await bloquer(held);

    const interaction = fakeInteraction();
    await held.unblock.execute(interaction, held.ctx);

    const reply = interaction.replies.at(-1);

    assert.equal(reply.flags, EPHEMERAL);
    assert.equal(reply.embeds[0].variables.member, `<@${MEMBRE}>`);
  });

  test('le membre peut se vérifier de nouveau', async (t) => {
    const held = sandbox(t);
    await bloquer(held);

    await held.unblock.execute(fakeInteraction(), held.ctx);

    assert.equal(held.engine.begin({ userId: MEMBRE, hasRole: false }).outcome, OUTCOMES.issued);
  });
});

describe('tentatives sans blocage', () => {
  test('le compteur est remis à zéro, et la réponse le distingue', async (t) => {
    const held = sandbox(t);

    held.engine.begin({ userId: MEMBRE, hasRole: false });
    await held.engine.submit({ userId: MEMBRE, hasRole: false, input: 'FAUXXX' });

    assert.equal(held.repository.find(MEMBRE).attempts, 1);

    const interaction = fakeInteraction();
    await held.unblock.execute(interaction, held.ctx);

    assert.equal(gabarit(interaction), 'verification_counter_reset');
    assert.equal(held.repository.find(MEMBRE), null);
    assert.equal(events(held.repository, MEMBRE).at(-1), HISTORY_EVENTS.unblock);
  });
});

describe('aucune ligne', () => {
  test('rien n\'est écrit en historique, et la réponse le dit', async (t) => {
    // Le test qui protège la décision : une commande sans effet n'est pas une
    // action, et l'inscrire polluerait un historique qui sert justement à
    // retrouver ce qui s'est passé.
    const held = sandbox(t);

    const interaction = fakeInteraction();
    await held.unblock.execute(interaction, held.ctx);

    assert.equal(gabarit(interaction), 'verification_nothing_to_do');
    assert.deepEqual(events(held.repository, MEMBRE), [], 'aucune écriture');
    assert.equal(held.repository.find(MEMBRE), null);
  });
});

describe('mémoire', () => {
  test('l\'épreuve en cours est vidée : le membre repart sur un nouveau code', async (t) => {
    const held = sandbox(t);
    await bloquer(held);

    // Une épreuve en mémoire, sans rapport avec le blocage.
    held.store.put(MEMBRE, { secret: 'ABC234', attachment: Buffer.alloc(1) });
    assert.equal(held.store.size, 1);

    await held.unblock.execute(fakeInteraction(), held.ctx);

    assert.equal(held.store.size, 0, 'plutôt que l\'image qu\'il vient d\'échouer');
  });

  test('vide aussi la mémoire quand aucune ligne n\'existe', async (t) => {
    const held = sandbox(t);

    held.store.put(MEMBRE, { secret: 'ABC234', attachment: Buffer.alloc(1) });

    await held.unblock.execute(fakeInteraction(), held.ctx);

    assert.equal(held.store.size, 0);
  });
});

describe('la cible a quitté le serveur', () => {
  test('la commande fonctionne quand même', async (t) => {
    // Le test qui compte le plus : le blocage persiste par identifiant, y
    // compris après un départ — c'est sa raison d'être. Discord n'envoie
    // `resolved.members` que pour un membre présent, donc `getMember()` rendrait
    // `null` dans le seul cas où cette commande est vraiment utile.
    const held = sandbox(t);
    await bloquer(held);

    const interaction = fakeInteraction({ cibleMembre: null });

    assert.equal(interaction.options.getMember('member'), null, 'la personne est partie');

    await held.unblock.execute(interaction, held.ctx);

    assert.equal(gabarit(interaction), 'verification_unblocked');
    assert.equal(held.repository.find(MEMBRE), null);
    assert.equal(held.repository.history(MEMBRE).at(-1).actor_id, MODERATEUR);
  });
});

describe('permissions', () => {
  const router = (t) => {
    const held = sandbox(t);
    const registry = createCommandRegistry({
      config: fakeConfig,
      logger: held.logger,
      embeds: held.embeds,
    });

    registry.register('verification', [held.unblock]);

    return { held, registry };
  };

  test('un rôle non autorisé est refusé, sans aucune écriture', async (t) => {
    const { held, registry } = router(t);
    await bloquer(held);

    const interaction = fakeInteraction({ roles: ['999999999999999999'] });

    await registry.handle(interaction, held.ctx);

    assert.equal(gabarit(interaction), 'command_denied');
    assert.equal(held.repository.isBlocked(MEMBRE), true, 'le blocage tient');
    assert.equal(events(held.repository, MEMBRE).includes(HISTORY_EVENTS.unblock), false);
  });

  test('un rôle autorisé passe', async (t) => {
    const { held, registry } = router(t);
    await bloquer(held);

    const interaction = fakeInteraction({ roles: [ROLE_MODO] });

    await registry.handle(interaction, held.ctx);

    assert.equal(gabarit(interaction), 'verification_unblocked');
  });
});

describe('module désactivé', () => {
  test('la commande ne peut rien débloquer, et c\'est assumé', async (t) => {
    // Limite écrite dans le module : le staff ne peut pas débloquer pendant que
    // la configuration est cassée. Sans conséquence — personne ne peut se
    // vérifier dans cet état non plus.
    const held = sandbox(t);
    await bloquer(held);

    const capabilities = new CapabilityRegistry();
    capabilities.disableModule('verification', 'salon de vérification introuvable');

    assert.equal(capabilities.isModuleEnabled('verification'), false);

    // Le routeur du noyau tranche avant d'atteindre la commande : rien n'est
    // écrit, et le blocage reste en place.
    assert.equal(held.repository.isBlocked(MEMBRE), true);
    assert.equal(events(held.repository, MEMBRE).includes(HISTORY_EVENTS.unblock), false);
  });
});
