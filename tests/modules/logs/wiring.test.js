import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { CapabilityRegistry } from '../../../src/core/config/capabilities.js';
import { createDatabase } from '../../../src/core/database/index.js';
import { createEmbedEngine } from '../../../src/core/embeds/index.js';
import { CORE_OWNER } from '../../../src/core/database/migrations.js';
import { AUDIT_ACTION_NAMES, logChannelCapability } from '../../../src/modules/logs/constants.js';
import {
  attach,
  capabilities as declared,
  getDispatcher,
  getPending,
  getRecorder,
  init,
  name,
} from '../../../src/modules/logs/index.js';
import { fromRoot } from '../../../src/utils/paths.js';
import { logsConfig } from './config-fixture.js';

/**
 * Câblage du module et mode dégradé.
 *
 * `init()` tourne AVANT la connexion : ni le journal d'audit, ni les rôles, ni
 * l'identifiant du bot n'existent encore. Le module doit se monter quand même,
 * fonctionner en dégradé — tout en `unknown` — et le dire une fois.
 *
 * Rien n'est importé de discord.js ici : `attach()` reçoit des fonctions, et
 * c'est ce qui permet d'éprouver tout le câblage sans réseau ni jeton. Les
 * adaptateurs qui produisent ces fonctions ont leurs propres tests.
 */

const MEMBRE = '123456789012345678';
const AT = new Date(Date.UTC(2026, 7, 18, 14, 32, 7, 512));

/**
 * Énumération complète, telle qu'`AuditLogEvent` la fournit.
 *
 * Les valeurs n'ont aucune importance — seule compte leur présence sous chaque
 * nom de `AUDIT_ACTIONS`. Les vrais entiers viennent de discord.js, que ce
 * fichier n'importe pas.
 */
const ENUMERATION = Object.fromEntries(AUDIT_ACTION_NAMES.map((held, index) => [held, index + 1]));

/** Branchement complet : les quatre accès et l'énumération. */
const branchement = (patch = {}) => ({
  fetchEntries: async () => [],
  resolveRoles: async () => [],
  botUserId: '444444444444444444',
  send: async () => null,
  auditActions: ENUMERATION,
  ...patch,
});

const fakeLogger = () => {
  const entries = [];
  const record = (level) => (message, context) => entries.push({ level, message, context });
  const logger = {
    entries,
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    of: (level) => entries.filter((entry) => entry.level === level),
  };

  logger.forModule = () => logger;

  return logger;
};

/**
 * Configuration réelle du dépôt, événements activés.
 *
 * C'est elle qui porte les défauts du schéma. Les bascules d'activation sont
 * retournées par la fixture : elles sont livrées à `false` — le premier
 * démarrage se fait sur le serveur réel — et un test qui en dépendrait
 * tomberait le jour où le staff active une famille.
 */
const config = logsConfig();

const mount = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cubex-logs-wiring-'));
  const logger = fakeLogger();
  const database = createDatabase({ file: join(root, 'test.sqlite'), logger: fakeLogger() });

  // Aucun débranchement à faire ici : `init()` remet les accès Discord à zéro,
  // parce que le module démarre toujours avant la connexion. Le montage du test
  // suivant repart donc en dégradé de lui-même.
  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  database.migrate([
    { owner: CORE_OWNER, directory: fromRoot('migrations') },
    { owner: name, directory: fromRoot('src', 'modules', 'logs', 'migrations') },
  ]);

  const capabilities = new CapabilityRegistry();

  for (const declaration of declared) capabilities.declare(declaration.id, { module: name });

  const arrets = [];

  init({
    config,
    database,
    logger,
    capabilities,
    // Le VRAI moteur du socle, sur les gabarits livrés : un moteur factice ne
    // prouverait pas qu'`embeds.yml` et `messages.yml` rendent quoi que ce soit.
    embeds: createEmbedEngine({ config, logger }),
    shutdown: { register: (step, close) => arrets.push({ step, close }) },
  });

  return {
    arrets,
    database,
    logger,
    rows: (table) => database.prepare(`SELECT * FROM ${table}`).all(),
  };
};

const input = (patch = {}) => ({
  type: 'member_ban',
  occurredAt: AT,
  actorId: null,
  actorConfidence: 'unknown',
  targetId: MEMBRE,
  channelId: null,
  source: 'live',
  ...patch,
});

describe('montage', () => {
  test('monte le dépôt, la file et le point d\'entrée unique', (t) => {
    mount(t);

    assert.notEqual(getRecorder(), null);
    assert.notEqual(getPending(), null);
    assert.equal(typeof getRecorder().record, 'function');
  });

  test('inscrit les deux vidages, dans l\'ordre qui les fait partir à l\'envers', (t) => {
    // Un événement encore en attente quand le bot s'arrête n'existe nulle part
    // ailleurs : Discord ne le rejouera pas.
    //
    // La séquence d'arrêt déroule ses étapes à l'ENVERS de leur inscription :
    // le dispatcher inscrit en premier part donc en dernier, après la file
    // d'écriture. L'ordre inverse laisserait les derniers événements en base
    // sans jamais les afficher.
    const { arrets } = mount(t);

    assert.deepEqual(arrets.map((held) => held.step), [`${name}:dispatch`, name]);
    for (const arret of arrets) assert.equal(typeof arret.close, 'function');
  });

  test('annonce l\'état dégradé une seule fois, en info', (t) => {
    const { logger } = mount(t);

    const montage = logger.of('info').filter((held) => held.message.includes('montée'));

    assert.equal(montage.length, 1);
    assert.equal(montage[0].context.discord_attached, false);
    assert.equal(montage[0].context.write_delay_ms > 0, true, 'le défaut du schéma est lu');
  });
});

describe('mode dégradé, avant attach()', () => {
  test('écrit quand même, en unknown', async (t) => {
    // Aucune corrélation possible sans accès au journal d'audit. Écrire
    // `unknown` est le résultat correct, pas un échec.
    const { rows } = mount(t);

    const resultat = await getRecorder().record(input());

    assert.notEqual(resultat, null);

    const [ligne] = rows('log_events');

    assert.equal(ligne.actor_id, null);
    assert.equal(ligne.actor_confidence, 'unknown');
  });

  test('n\'exclut personne faute d\'identité du bot', async (t) => {
    // Mieux vaut journaliser de trop que d'ignorer à tort : un événement ignoré
    // ne laisse aucune trace.
    const { rows } = mount(t);

    await getRecorder().record(input({ targetId: MEMBRE }));

    assert.equal(rows('log_events').length, 1);
  });

  test('aucun avertissement : le dégradé n\'est pas une panne', async (t) => {
    const { logger } = mount(t);

    await getRecorder().record(input());

    assert.equal(logger.of('warn').length, 0);
    assert.equal(logger.of('error').length, 0);
  });
});

describe('attach()', () => {
  test('branche les quatre accès', (t) => {
    mount(t);

    const branche = attach(branchement());

    assert.equal(typeof branche.fetchEntries, 'function');
    assert.equal(typeof branche.resolveRoles, 'function');
    assert.equal(typeof branche.send, 'function');
    assert.equal(branche.botUserId, '444444444444444444');
  });

  test('les quatre accès sont EXIGÉS, chacun nommé s\'il manque', (t) => {
    // Un accès manquant ne produirait aucune erreur à l'usage : le module
    // continuerait d'écrire sans corréler, sans exclure par rôle ou sans rien
    // envoyer, et personne ne s'en apercevrait avant d'aller chercher un
    // événement jamais affiché. Le dégradé est l'état d'AVANT la connexion,
    // jamais le résultat d'un câblage incomplet.
    mount(t);

    for (const key of ['fetchEntries', 'resolveRoles', 'botUserId', 'send']) {
      assert.throws(() => attach(branchement({ [key]: undefined })), new RegExp(key), key);
    }
  });

  test('l\'énumération est EXIGÉE, et non plus facultative', (t) => {
    // Sans elle, aucun nom de AUDIT_ACTIONS ne peut être confronté à la
    // bibliothèque : toute la table serait inopérante, chaque événement
    // conclurait `unknown`, et rien ne le dirait.
    mount(t);

    assert.throws(() => attach(branchement({ auditActions: undefined })), /énumération/);
  });

  test('la corrélation devient effective sans remontage', async (t) => {
    // Les adaptateurs consultent l'état à CHAQUE appel : figer la valeur au
    // montage laisserait le module dégradé pour toujours.
    const { rows } = mount(t);

    // Horodatage courant, et non la constante du fichier : le VRAI cache écarte
    // les entrées plus vieilles que la fenêtre de corrélation, mesurée depuis
    // maintenant. C'est ce qui distingue ce test de ceux de correlation.test.js,
    // où le cache est factice et ne purge rien.
    const maintenant = new Date();

    attach(
      branchement({
        fetchEntries: async () => [
          {
            id: '900000000000000001',
            actionName: 'MemberBanAdd',
            executorId: '111111111111111111',
            targetId: MEMBRE,
            channelId: null,
            count: 1,
            createdAt: maintenant,
          },
        ],
      }),
    );

    await getRecorder().record(input({ occurredAt: maintenant }));

    const [ligne] = rows('log_events');

    assert.equal(ligne.actor_id, '111111111111111111');
    assert.equal(ligne.actor_confidence, 'probable');
  });

  test('un nom absent de l\'énumération lève au démarrage, en le nommant', (t) => {
    // Un nom inconnu produit `undefined` à la résolution, et une requête sur
    // `undefined` ne rend rien : la journalisation continuerait en attribuant
    // `unknown` à tout un type d'événement, sans qu'aucune erreur ne le
    // signale. C'est exactement la panne qu'on ne voit jamais.
    mount(t);

    assert.doesNotThrow(() => attach(branchement()));

    const { MemberKick: _absent, ...incomplete } = ENUMERATION;

    assert.throws(() => attach(branchement({ auditActions: incomplete })), /MemberKick/);
  });
});

describe('branchement de l\'envoi', () => {
  test('sans send, la ligne est écrite et rien n\'est envoyé', async (t) => {
    // Mode dégradé : le module écrit en base et n'envoie rien, ce que le
    // démarrage annonce une fois.
    const { rows, logger } = mount(t);

    await getRecorder().record(input());
    await getDispatcher().flush();

    assert.equal(rows('log_events').length, 1);
    assert.equal(logger.of('warn').length, 0, 'ne pas envoyer n\'est pas une panne');

    const [montage] = logger.of('info').filter((held) => held.message.includes('montée'));

    assert.equal(montage.context.sending, false);
  });

  test('un événement écrit est mis en file d\'envoi', async (t) => {
    // Le point de branchement prévu au lot 2 : la valeur de retour de write().
    const { rows } = mount(t);
    const envois = [];

    attach(
      branchement({
        send: async (message) => {
          envois.push(message);
        },
      }),
    );

    await getRecorder().record(input());
    await getDispatcher().flush();

    assert.equal(rows('log_events').length, 1);
    assert.equal(envois.length, 1);
    assert.equal(envois[0].embeds.length, 1);
    assert.equal(typeof envois[0].channelId, 'string');
  });

  test('un événement exclu n\'est ni écrit ni envoyé', async (t) => {
    const { rows } = mount(t);
    const envois = [];

    attach(
      branchement({
        botUserId: MEMBRE,
        send: async (message) => {
          envois.push(message);
        },
      }),
    );

    // Le membre visé EST le bot : l'événement est écarté par les exclusions.
    assert.equal(await getRecorder().record(input()), null);

    await getDispatcher().flush();

    assert.equal(rows('log_events').length, 0);
    assert.equal(envois.length, 0);
  });
});

describe('capacités déclarées', () => {
  test('l\'aiguillage interroge exactement les capacités déclarées', (t) => {
    mount(t);

    assert.deepEqual(
      declared.map((held) => held.id),
      ['messages', 'voice', 'members', 'server', 'moderation'].map(logChannelCapability),
    );
  });
});

describe('raison reprise du journal d\'audit', () => {
  const RAISON = 'publicité répétée';

  /** Entrée d'audit candidate pour le bannissement de `input()`. */
  const audit = (maintenant, patch = {}) => [
    {
      id: '900000000000000001',
      actionName: 'MemberBanAdd',
      executorId: '111111111111111111',
      targetId: MEMBRE,
      channelId: null,
      count: 1,
      createdAt: maintenant,
      reason: RAISON,
      ...patch,
    },
  ];

  const donnees = (rows) => JSON.parse(rows('log_events')[0].data);

  test('une candidate unique écrit la raison dans data', async (t) => {
    // La charge utile d'un bannissement ne porte pas la raison : elle ne vit
    // que dans le journal d'audit, qui expire à quatre-vingt-dix jours. Le
    // casier de la phase 3 en aura besoin.
    const { rows } = mount(t);
    const maintenant = new Date();

    attach(branchement({ fetchEntries: async () => audit(maintenant) }));

    await getRecorder().record(input({ occurredAt: maintenant }));

    assert.equal(donnees(rows).reason, RAISON);
  });

  test('la raison va dans data, jamais dans une colonne', async (t) => {
    const { rows, database } = mount(t);
    const maintenant = new Date();

    attach(branchement({ fetchEntries: async () => audit(maintenant) }));

    await getRecorder().record(input({ occurredAt: maintenant }));

    const colonnes = database.prepare('SELECT * FROM log_events').columns().map((c) => c.name);

    assert.equal(colonnes.includes('reason'), false, 'aucune colonne n\'est ajoutée');
    assert.equal(rows('log_events').length, 1);
  });

  test('plusieurs candidates n\'écrivent AUCUNE raison', async (t) => {
    // Même règle que la promotion : reprendre la raison d'une entrée parmi
    // plusieurs écrirait au dossier d'un membre le motif d'une sanction visant
    // quelqu'un d'autre.
    const { rows } = mount(t);
    const maintenant = new Date();

    attach(
      branchement({
        fetchEntries: async () => [
          ...audit(maintenant),
          ...audit(maintenant, { id: '900000000000000002', executorId: '333333333333333333' }),
        ],
      }),
    );

    await getRecorder().record(input({ occurredAt: maintenant }));

    assert.deepEqual(donnees(rows), {}, 'ni raison, ni acteur');
  });

  test('sans raison, data ne gagne pas de clé nulle', async (t) => {
    const { rows } = mount(t);
    const maintenant = new Date();

    attach(branchement({ fetchEntries: async () => audit(maintenant, { reason: null }) }));

    await getRecorder().record(input({ occurredAt: maintenant }));

    assert.equal(Object.hasOwn(donnees(rows), 'reason'), false);
  });

  test('une raison venue de la passerelle prime sur celle de l\'audit', async (t) => {
    // Ce qui accompagne l'événement lui-même est un FAIT ; ce que la
    // corrélation trouve n'est qu'une déduction `probable`. Écraser le premier
    // par le second remplacerait un fait par une hypothèse.
    const { rows } = mount(t);
    const maintenant = new Date();

    attach(branchement({ fetchEntries: async () => audit(maintenant) }));

    await getRecorder().record(
      input({ occurredAt: maintenant, data: { reason: 'raison de la passerelle' } }),
    );

    assert.equal(donnees(rows).reason, 'raison de la passerelle');
  });
});
