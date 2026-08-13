import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CapabilityRegistry } from '../../../src/core/config/capabilities.js';
import {
  createComponentRegistry,
  decodeCustomId,
  encodeCustomId,
  routeInteraction,
} from '../../../src/core/components/index.js';
import { EPHEMERAL } from '../../../src/core/discord/flags.js';

const ID = '123456789012345678';

/** Journal factice : retient les entrées au lieu de les écrire. */
const fakeLogger = () => {
  const entries = [];
  const record = (level) => (message, context) => entries.push({ level, message, context });

  return {
    entries,
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    of: (level) => entries.filter((entry) => entry.level === level),
  };
};

/**
 * Moteur d'embeds factice : rend le nom du gabarit au lieu d'un embed, pour que
 * chaque test nomme la réponse attendue plutôt que de la deviner.
 */
const fakeEmbeds = () => ({
  render: (template, variables = {}) => ({ template, variables }),
});

/** Interaction factice : retient ce qu'on lui répond. */
const interaction = (customId, { roles = [], failing = false } = {}) => ({
  customId,
  member: { roles },
  user: { id: ID },
  replied: false,
  deferred: false,
  replies: [],

  reply(payload) {
    if (failing) return Promise.reject(new Error('Unknown interaction'));

    this.replies.push(payload);
    this.replied = true;

    return Promise.resolve();
  },

  followUp(payload) {
    this.replies.push({ ...payload, followUp: true });
    return Promise.resolve();
  },
});

const registry = ({ config = {}, capabilities = new CapabilityRegistry() } = {}) => {
  const logger = fakeLogger();
  const store = { 'commands.embed.allowed_roles': [ID], ...config };

  const components = createComponentRegistry({
    config: { get: (path, ...fallback) => (path in store ? store[path] : fallback[0]) },
    logger,
    embeds: fakeEmbeds(),
    capabilities,
  });

  return { components, logger, capabilities, store };
};

/** Nom du gabarit rendu en réponse. */
const answered = (fake) => fake.replies.at(-1)?.embeds[0].template;

describe('identifiant persistant', () => {
  test('encode et décode symétriquement, arguments préservés', () => {
    const customId = encodeCustomId('verification', 'confirm', ID, 'fr');

    assert.equal(customId, `verification:confirm:${ID}:fr`);
    assert.deepEqual(decodeCustomId(customId), {
      module: 'verification',
      action: 'confirm',
      args: [ID, 'fr'],
    });
  });

  test('encode sans argument', () => {
    assert.deepEqual(decodeCustomId(encodeCustomId('verification', 'start')), {
      module: 'verification',
      action: 'start',
      args: [],
    });
  });

  test('refuse un dépassement du plafond de 100 caractères, sans tronquer', () => {
    // Un identifiant coupé ne route nulle part — ou pire, route vers autre
    // chose si la coupure tombe au milieu d'un segment.
    const long = 'x'.repeat(90);

    assert.throws(() => encodeCustomId('verification', 'confirm', long), /plafond de 100/);
    assert.equal(encodeCustomId('verification', 'confirm', 'x'.repeat(79)).length, 100);
  });

  test('refuse un segment contenant le séparateur', () => {
    assert.throws(() => encodeCustomId('verification', 'confirm', 'a:b'), /séparateur réservé/);
    assert.throws(() => encodeCustomId('mod:ule', 'confirm'), /séparateur réservé/);
  });

  test('refuse un argument qui n\'est pas une chaîne', () => {
    // Pas de String(value) de complaisance : accepter un nombre, c'est accepter
    // qu'un identifiant Discord arrive déjà tronqué.
    assert.throws(() => encodeCustomId('verification', 'page', 2), /chaîne non vide/);
    assert.throws(() => encodeCustomId('verification', 'page', 123456789012345678), /chaîne non vide/);
    assert.throws(() => encodeCustomId('verification', 'confirm', ''), /chaîne non vide/);
    assert.throws(() => encodeCustomId('verification', 'confirm', undefined), /chaîne non vide/);
  });

  test('le message de refus nomme le segment fautif', () => {
    assert.throws(() => encodeCustomId('verification', 'confirm', 'a:b'), /argument 0/);
    assert.throws(() => encodeCustomId('verification', 'con:firm'), /action/);
  });

  test('décode null sur un identifiant malformé', () => {
    for (const customId of ['', 'verification', 'verification:', ':confirm', null, undefined, 42]) {
      assert.equal(decodeCustomId(customId), null, `pour ${JSON.stringify(customId)}`);
    }
  });

  test('décrit un identifiant ancien plutôt que de le juger', () => {
    // La chaîne vient d'un message qui peut dater : le décodeur est tolérant là
    // où l'encodeur est strict. Un argument vide final n'empêche pas de router.
    assert.deepEqual(decodeCustomId('verification:confirm:'), {
      module: 'verification',
      action: 'confirm',
      args: [''],
    });
  });
});

describe('déclaration d\'un composant', () => {
  const refuse = (declaration, motif) => {
    const { components } = registry();

    assert.throws(() => components.register('verification', [declaration]), motif);
  };

  const valide = { action: 'confirm', permission: 'public', execute: () => {} };

  test('accepte une déclaration conforme', () => {
    const { components } = registry();

    components.register('verification', [valide]);

    assert.deepEqual(components.list(), [{ owner: 'verification', action: 'confirm' }]);
  });

  test('refuse une action absente ou mal formée', () => {
    refuse({ ...valide, action: undefined }, /« action » attendue/);
    refuse({ ...valide, action: 'Confirm' }, /« action » attendue/);
    refuse({ ...valide, action: 'con firm' }, /« action » attendue/);
  });

  test('refuse un execute absent ou qui n\'est pas une fonction', () => {
    refuse({ action: 'confirm', permission: 'public' }, /« execute » doit être une fonction/);
    refuse({ ...valide, execute: 'oui' }, /« execute » doit être une fonction/);
  });

  test('refuse une déclaration sans permission', () => {
    // Aucun défaut : ouvrir par défaut ouvrirait à tous, fermer par défaut
    // rendrait muet un bouton destiné aux membres non vérifiés.
    refuse({ action: 'confirm', execute: () => {} }, /ni « permission » ni « permission_key »/);
  });

  test('refuse une déclaration portant les deux', () => {
    refuse(
      { ...valide, permission_key: 'commands.embed.allowed_roles' },
      /l'une ou l'autre, jamais les deux/,
    );
  });

  test('refuse une permission autre que le littéral public', () => {
    refuse({ ...valide, permission: [ID] }, /n'admet que le littéral "public"/);
    refuse({ ...valide, permission: true }, /n'admet que le littéral "public"/);
  });

  test('refuse une clé de permission qui n\'est pas une chaîne', () => {
    refuse(
      { action: 'confirm', permission_key: [ID], execute: () => {} },
      /chemin pointé vers config\.yml/,
    );
  });

  test('refuse deux fois la même action pour un même module', () => {
    const { components } = registry();

    components.register('verification', [valide]);

    assert.throws(() => components.register('verification', [valide]), /déjà déclaré/);
  });

  test('deux modules déclarent la même action sans se marcher dessus', () => {
    const { components } = registry();

    components.register('verification', [valide]);
    components.register('tickets', [valide]);

    assert.equal(components.size, 2);
  });
});

describe('rapport de démarrage', () => {
  test('signale un composant dont la clé de permission ne résout pas', () => {
    const { components } = registry();

    components.register('verification', [
      { action: 'start', permission_key: 'commands.absente.allowed_roles', execute: () => {} },
      { action: 'code', permission_key: 'commands.embed.allowed_roles', execute: () => {} },
      { action: 'open', permission: 'public', execute: () => {} },
    ]);

    assert.deepEqual(components.unconfigured(), ['verification:start']);
  });
});

describe('routage', () => {
  const withComponent = (declaration, options = {}) => {
    const held = registry(options);
    const appels = [];

    held.components.register('verification', [
      {
        action: 'confirm',
        permission: 'public',
        execute: (...args) => appels.push(args),
        ...declaration,
      },
    ]);

    return { ...held, appels };
  };

  test('route vers le bon module quand deux déclarent la même action', async () => {
    const { components } = registry();
    const vus = [];

    for (const owner of ['verification', 'tickets']) {
      components.register(owner, [
        { action: 'confirm', permission: 'public', execute: () => vus.push(owner) },
      ]);
    }

    await components.handle(interaction('tickets:confirm'), {});

    assert.deepEqual(vus, ['tickets']);
  });

  test('transmet l\'interaction, le contexte puis les arguments décodés', async () => {
    const { appels } = withComponent({});
    const fake = interaction(`verification:confirm:${ID}:fr`);

    const held = registry();
    held.components.register('verification', [
      { action: 'confirm', permission: 'public', execute: (...args) => appels.push(args) },
    ]);

    await held.components.handle(fake, { database: 'base' });

    const [reçue, context, args] = appels.at(-1);

    assert.equal(reçue, fake, 'l\'interaction en premier, comme les commandes');
    assert.equal(context.database, 'base');
    assert.equal(context.module, 'verification');
    assert.deepEqual(args, [ID, 'fr'], 'les arguments décodés en dernier');
  });

  test('répond au préfixe inconnu avec le gabarit dédié, sans lever', async () => {
    const { components, logger } = registry();
    const fake = interaction('disparu:confirm');

    // Vieux message resté dans un salon après un déploiement : sans réponse, le
    // membre voit « L'application ne répond pas ».
    await assert.doesNotReject(() => components.handle(fake, {}));

    assert.equal(answered(fake), 'component_expired');
    assert.equal(fake.replies.at(-1).flags, EPHEMERAL);
    assert.match(logger.of('warn').at(-1).message, /sans destinataire/);
  });

  test('répond de même à un identifiant malformé', async () => {
    const { components } = registry();
    const fake = interaction('n-importe-quoi');

    await components.handle(fake, {});

    assert.equal(answered(fake), 'component_expired');
  });

  test('module désactivé : feature_unavailable, execute jamais appelé', async () => {
    const capabilities = new CapabilityRegistry();
    const { components, appels } = withComponent({}, { capabilities });

    capabilities.disableModule('verification', 'salon introuvable');

    const fake = interaction('verification:confirm');
    await components.handle(fake, {});

    assert.equal(answered(fake), 'feature_unavailable');
    assert.deepEqual(appels, []);
  });

  test('refus de permission : command_denied, execute jamais appelé', async () => {
    const { components, appels } = withComponent({
      permission: undefined,
      permission_key: 'commands.embed.allowed_roles',
    });

    const fake = interaction('verification:confirm', { roles: ['999999999999999999'] });
    await components.handle(fake, {});

    assert.equal(answered(fake), 'command_denied');
    assert.deepEqual(appels, []);
  });

  test('permission accordée par un rôle configuré', async () => {
    const { components, appels } = withComponent({
      permission: undefined,
      permission_key: 'commands.embed.allowed_roles',
    });

    await components.handle(interaction('verification:confirm', { roles: [ID] }), {});

    assert.equal(appels.length, 1);
  });

  test('une clé de permission qui ne résout pas refuse à tous', async () => {
    // Même règle que pour une commande sans entrée : un oubli se remarque par
    // un refus, jamais par une ouverture.
    const { components, appels } = withComponent({
      permission: undefined,
      permission_key: 'commands.absente.allowed_roles',
    });

    const fake = interaction('verification:confirm', { roles: [ID] });
    await components.handle(fake, {});

    assert.equal(answered(fake), 'command_denied');
    assert.deepEqual(appels, []);
  });

  test('permission public : ouvert même sans aucun rôle', async () => {
    // Le bouton « Se vérifier » s'adresse à des membres qui n'ont aucun rôle.
    const { components, appels } = withComponent({});

    await components.handle(interaction('verification:confirm', { roles: [] }), {});

    assert.equal(appels.length, 1);
  });
});

describe('un composant répond toujours', () => {
  test('un execute qui rejette produit command_failed, sans rejet non capturé', async (t) => {
    const rejets = [];
    const guet = (reason) => rejets.push(reason);

    process.on('unhandledRejection', guet);
    t.after(() => process.off('unhandledRejection', guet));

    const { components, logger } = registry();

    components.register('verification', [
      {
        action: 'confirm',
        permission: 'public',
        execute: async () => {
          throw new Error('publication impossible');
        },
      },
    ]);

    const fake = interaction('verification:confirm');
    await components.handle(fake, {});

    assert.equal(answered(fake), 'command_failed');
    assert.match(logger.of('error').at(-1).message, /composant en échec/);
    assert.equal(logger.of('error').at(-1).context.action, 'confirm');
    assert.deepEqual(rejets, []);
  });

  test('une réponse impossible est journalisée sans faire tomber le processus', async () => {
    // Interaction expirée : insister produirait une seconde erreur au même
    // endroit. Le journal en garde la trace, le processus continue.
    const { components, logger } = registry();
    const fake = interaction('disparu:confirm', { failing: true });

    await assert.doesNotReject(() => components.handle(fake, {}));

    assert.match(logger.of('error').at(-1).message, /réponse impossible/);
  });

  test('passe par followUp quand le module a déjà répondu', async () => {
    const { components } = registry();

    components.register('verification', [
      {
        action: 'confirm',
        permission: 'public',
        execute: async (received) => {
          received.deferred = true;
          throw new Error('échec après accusé de réception');
        },
      },
    ]);

    const fake = interaction('verification:confirm');
    await components.handle(fake, {});

    assert.equal(fake.replies.at(-1).followUp, true);
  });
});

describe('aiguillage des interactions', () => {
  const registres = () => {
    const routées = [];

    return {
      routées,
      commands: { handle: async (received) => routées.push(['commande', received]) },
      components: { handle: async (received) => routées.push(['composant', received]) },
    };
  };

  const kind = (type) => ({
    customId: 'verification:confirm',
    isChatInputCommand: () => type === 'command',
    isMessageComponent: () => type === 'button' || type === 'select',
    isModalSubmit: () => type === 'modal',
  });

  test('les commandes slash continuent d\'être routées comme avant', async () => {
    const { routées, commands, components } = registres();

    await routeInteraction(kind('command'), { commands, components, context: {} });

    assert.equal(routées.at(-1)[0], 'commande');
  });

  test('les trois types porteurs d\'un customId routent vers les composants', async () => {
    for (const type of ['button', 'select', 'modal']) {
      const { routées, commands, components } = registres();

      await routeInteraction(kind(type), { commands, components, context: {} });

      assert.equal(routées.at(-1)[0], 'composant', `type ${type}`);
    }
  });

  test('ignore ce qu\'aucun registre ne traite', () => {
    const { routées, commands, components } = registres();
    const autocomplete = {
      isChatInputCommand: () => false,
      isMessageComponent: () => false,
      isModalSubmit: () => false,
    };

    assert.equal(routeInteraction(autocomplete, { commands, components }), null);
    assert.deepEqual(routées, []);
  });
});
