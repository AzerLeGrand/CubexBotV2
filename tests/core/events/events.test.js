import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, test } from 'node:test';

import { Events } from 'discord.js';

import { CapabilityRegistry } from '../../../src/core/config/capabilities.js';
import { createEventRegistry, runReady } from '../../../src/core/events/index.js';

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
 * Client factice : retient ce qu'on lui attache et sait le réémettre.
 *
 * Un vrai Client demanderait une connexion ; ce qui se teste ici est le
 * câblage, pas discord.js.
 */
const fakeClient = () => {
  const listeners = [];

  return {
    listeners,
    on: (name, listener) => listeners.push({ name, listener, once: false }),
    once: (name, listener) => listeners.push({ name, listener, once: true }),
    emit: (name, ...args) => {
      for (const entry of listeners.filter((held) => held.name === name)) entry.listener(...args);
    },
  };
};

const registry = (capabilities = new CapabilityRegistry()) => {
  const logger = fakeLogger();

  return { logger, capabilities, events: createEventRegistry({ logger, capabilities }) };
};

/** Attend que les microtâches de l'enveloppe soient retombées. */
const settle = () => delay(0);

describe('déclaration d\'un écouteur', () => {
  const refuse = (listener, motif) => {
    const { events } = registry();

    assert.throws(() => events.register('verification', [listener]), motif);
  };

  test('accepte une déclaration conforme', () => {
    const { events } = registry();

    events.register('verification', [{ name: 'messageDelete', execute: () => {} }]);

    assert.deepEqual(events.list(), [
      { owner: 'verification', name: 'messageDelete', once: false },
    ]);
  });

  test('refuse un nom d\'événement inconnu, en nommant le module', () => {
    // Un nom que Discord n'émet pas produit un écouteur jamais appelé : aucune
    // erreur, aucun symptôme, seulement du silence.
    refuse({ name: 'messageDeleted', execute: () => {} }, /écouteur .+ de verification/);
    refuse({ name: 'messageDeleted', execute: () => {} }, /événement inconnu de discord\.js/);
  });

  test('refuse la clé PascalCase et propose la valeur attendue', () => {
    // Le cas probable : `Events.MessageDelete` sous les yeux, la clé recopiée.
    refuse({ name: 'MessageDelete', execute: () => {} }, /"MessageDelete" — attendu "messageDelete"/);
  });

  test('les clés et les valeurs de Events sont deux ensembles disjoints', () => {
    // Sur quoi repose la suggestion ci-dessus. Si une version de discord.js
    // faisait d'une valeur une clé, le message deviendrait trompeur.
    const entries = Object.entries(Events);

    assert.ok(entries.length > 0);
    assert.deepEqual(entries.filter(([key, value]) => key === value), []);
    assert.deepEqual(Object.values(Events).filter((value) => Object.hasOwn(Events, value)), []);
    assert.ok(Object.values(Events).every((value) => typeof value === 'string'));
  });

  test('refuse un nom absent ou qui n\'est pas une chaîne', () => {
    refuse({ execute: () => {} }, /« name » attendu/);
    refuse({ name: 42, execute: () => {} }, /« name » attendu/);
  });

  test('refuse un execute absent ou qui n\'est pas une fonction', () => {
    refuse({ name: 'messageDelete' }, /« execute » doit être une fonction/);
    refuse({ name: 'messageDelete', execute: 'oui' }, /« execute » doit être une fonction/);
  });

  test('refuse un once qui n\'est pas un booléen', () => {
    refuse({ name: 'messageDelete', once: 1, execute: () => {} }, /« once » doit être un booléen/);
  });

  test('refuse clientReady, réservé au noyau, et renvoie vers ready(ctx)', () => {
    // La séquence du noyau enchaîne l'enregistrement des commandes puis la
    // vérification des références : un écouteur concurrent s'exécuterait avant
    // de savoir si sa capacité est active.
    refuse({ name: 'clientReady', execute: () => {} }, /réservé au noyau/);
    refuse({ name: 'clientReady', execute: () => {} }, /ready\(ctx\)/);
  });

  test('n\'interdit que clientReady parmi les événements du noyau', () => {
    const { events } = registry();

    // Plusieurs écouteurs coexistent sur ceux-là sans qu'aucun ordre ne compte.
    events.register('verification', [
      { name: 'interactionCreate', execute: () => {} },
      { name: 'error', execute: () => {} },
    ]);

    assert.equal(events.size, 2);
  });
});

describe('attachement au client', () => {
  test('pose un écouteur par déclaration et le journalise', () => {
    const { events, logger } = registry();
    const client = fakeClient();

    events.register('verification', [{ name: 'messageDelete', execute: () => {} }]);
    events.register('logs', [{ name: 'messageUpdate', execute: () => {} }]);
    events.attach(client, {});

    assert.deepEqual(client.listeners.map((held) => held.name), ['messageDelete', 'messageUpdate']);
    assert.equal(logger.of('info')[0].context.count, 2);
  });

  test('respecte once', () => {
    const { events } = registry();
    const client = fakeClient();

    events.register('verification', [
      { name: 'messageDelete', once: true, execute: () => {} },
      { name: 'messageUpdate', execute: () => {} },
    ]);
    events.attach(client, {});

    assert.deepEqual(client.listeners.map((held) => held.once), [true, false]);
  });

  test('transmet le contexte en premier, puis les arguments de l\'événement', async () => {
    const { events } = registry();
    const client = fakeClient();
    const reçus = [];

    events.register('verification', [
      { name: 'messageUpdate', execute: (...args) => reçus.push(args) },
    ]);
    events.attach(client, { database: 'base', config: 'conf' });

    client.emit('messageUpdate', 'avant', 'après');
    await settle();

    const [context, ...args] = reçus[0];

    assert.equal(context.database, 'base');
    assert.deepEqual(args, ['avant', 'après'], 'dans l\'ordre, après le contexte');
  });

  test('le contexte porte le nom du module, comme celui d\'init', async () => {
    const { events } = registry();
    const client = fakeClient();
    let vu = null;

    events.register('verification', [{ name: 'messageDelete', execute: (ctx) => (vu = ctx) }]);
    events.attach(client, { config: 'conf' });

    client.emit('messageDelete', {});
    await settle();

    assert.equal(vu.module, 'verification');
  });
});

describe('un écouteur ne fait jamais tomber le bot', () => {
  /**
   * Un rejet non capturé remonterait au gestionnaire d'arrêt, qui le traite en
   * défaillance fatale — sortie 1. Double preuve : aucun unhandledRejection
   * observé, et l'anomalie journalisée.
   */
  const guetteRejets = (t) => {
    const rejets = [];
    const guet = (reason) => rejets.push(reason);

    process.on('unhandledRejection', guet);
    t.after(() => process.off('unhandledRejection', guet));

    return rejets;
  };

  test('un gestionnaire async qui rejette est capturé et journalisé', async (t) => {
    const rejets = guetteRejets(t);
    const { events, logger } = registry();
    const client = fakeClient();

    events.register('verification', [
      {
        name: 'messageDelete',
        execute: async () => {
          throw new Error('salon inattendu');
        },
      },
    ]);
    events.attach(client, {});

    client.emit('messageDelete', {});
    await settle();

    const entrée = logger.of('error').at(-1);

    assert.match(entrée.message, /écouteur en échec/);
    assert.equal(entrée.context.module, 'verification');
    assert.equal(entrée.context.event, 'messageDelete');
    assert.match(entrée.context.error.message, /salon inattendu/);
    assert.deepEqual(rejets, [], 'aucun rejet n\'a échappé à l\'enveloppe');
  });

  test('un gestionnaire synchrone qui jette est capturé de la même façon', async (t) => {
    const rejets = guetteRejets(t);
    const { events, logger } = registry();
    const client = fakeClient();

    events.register('verification', [
      {
        name: 'messageDelete',
        execute: () => {
          throw new Error('boum');
        },
      },
    ]);
    events.attach(client, {});

    // L'émission elle-même ne doit pas jeter : discord.js appelle l'écouteur
    // depuis sa propre boucle.
    assert.doesNotThrow(() => client.emit('messageDelete', {}));
    await settle();

    assert.match(logger.of('error').at(-1).context.error.message, /boum/);
    assert.deepEqual(rejets, []);
  });

  test('un écouteur en échec n\'empêche pas les suivants', async () => {
    const { events } = registry();
    const client = fakeClient();
    const appelés = [];

    events.register('verification', [
      { name: 'messageDelete', execute: async () => { throw new Error('boum'); } },
    ]);
    events.register('logs', [
      { name: 'messageDelete', execute: () => appelés.push('logs') },
    ]);
    events.attach(client, {});

    client.emit('messageDelete', {});
    await settle();

    assert.deepEqual(appelés, ['logs']);
  });
});

describe('un module désactivé se tait', () => {
  const withDisabled = () => {
    const capabilities = new CapabilityRegistry();
    const { events, logger } = registry(capabilities);
    const client = fakeClient();
    const appelés = [];

    events.register('verification', [
      { name: 'messageDelete', execute: () => appelés.push('verification') },
    ]);
    events.attach(client, {});

    return { capabilities, client, appelés, logger };
  };

  test('l\'écouteur d\'un module désactivé n\'est pas appelé', async () => {
    const { capabilities, client, appelés } = withDisabled();

    capabilities.disableModule('verification', 'salon introuvable');
    client.emit('messageDelete', {});
    await settle();

    assert.deepEqual(appelés, []);
  });

  test('sans journaliser à chaque passage', async () => {
    const { capabilities, client, logger } = withDisabled();
    const avant = logger.entries.length;

    capabilities.disableModule('verification', 'salon introuvable');
    for (let i = 0; i < 5; i += 1) client.emit('messageDelete', {});
    await settle();

    // messageDelete sur un serveur actif remplirait les fichiers de bruit.
    assert.equal(logger.entries.length, avant);
  });

  test('l\'état est relu à chaque passage, pas figé à l\'attachement', async () => {
    const { capabilities, client, appelés } = withDisabled();

    capabilities.disableModule('verification', 'salon introuvable');
    client.emit('messageDelete', {});
    await settle();

    // Un /reload revérifie les références et peut réactiver le module : sans
    // réattachement, l'écouteur doit se remettre à répondre.
    capabilities.reset();
    client.emit('messageDelete', {});
    await settle();

    assert.deepEqual(appelés, ['verification']);
  });
});

describe('runReady', () => {
  const module = (name, ready = null) => ({ name, ready });

  test('appelle le ready de chaque module, avec le contexte et son nom', async () => {
    const logger = fakeLogger();
    const capabilities = new CapabilityRegistry();
    const vus = [];

    await runReady({
      modules: [module('verification', (ctx) => vus.push(ctx)), module('logs')],
      context: { database: 'base' },
      capabilities,
      logger,
    });

    assert.equal(vus.length, 1, 'un module sans ready ne produit rien');
    assert.equal(vus[0].database, 'base');
    assert.equal(vus[0].module, 'verification');
  });

  test('attend chaque ready avant de passer au suivant', async () => {
    const ordre = [];

    await runReady({
      modules: [
        module('a', async () => {
          await delay(5);
          ordre.push('a');
        }),
        module('b', () => ordre.push('b')),
      ],
      context: {},
      capabilities: new CapabilityRegistry(),
      logger: fakeLogger(),
    });

    assert.deepEqual(ordre, ['a', 'b']);
  });

  test('un ready en échec est journalisé et n\'interrompt ni les suivants ni la suite', async () => {
    const logger = fakeLogger();
    const ordre = [];

    // Ne rejette pas : c'est ce qui laisse purge.start() s'exécuter derrière.
    await runReady({
      modules: [
        module('verification', async () => {
          throw new Error('publication impossible');
        }),
        module('logs', () => ordre.push('logs')),
      ],
      context: {},
      capabilities: new CapabilityRegistry(),
      logger,
    });

    assert.deepEqual(ordre, ['logs']);

    const entrée = logger.of('error').at(-1);

    assert.match(entrée.message, /ready de module en échec/);
    assert.equal(entrée.context.module, 'verification');
    assert.match(entrée.context.error.message, /publication impossible/);
  });

  test('saute le ready d\'un module désactivé, en disant pourquoi', async () => {
    const logger = fakeLogger();
    const capabilities = new CapabilityRegistry();
    const appelés = [];

    capabilities.disableModule('verification', 'salon de vérification introuvable');

    await runReady({
      modules: [module('verification', () => appelés.push('verification'))],
      context: {},
      capabilities,
      logger,
    });

    assert.deepEqual(appelés, [], 'il publierait dans un salon qui n\'existe plus');

    const entrée = logger.of('info').at(-1);

    assert.match(entrée.message, /module désactivé/);
    assert.equal(entrée.context.module, 'verification');
    assert.match(entrée.context.reason, /salon de vérification introuvable/);
  });

  test('une capacité non critique tombée n\'empêche pas le ready du module', async () => {
    const capabilities = new CapabilityRegistry();
    const appelés = [];

    // Le cas de la phase 1 : le salon d'alerte a disparu, mais la publication
    // du message d'accueil et la vérification des membres doivent continuer.
    capabilities.declare('verification.alert', { module: 'verification' });
    capabilities.disable('verification.alert', 'salon d\'alerte introuvable');

    await runReady({
      modules: [module('verification', () => appelés.push('verification'))],
      context: {},
      capabilities,
      logger: fakeLogger(),
    });

    assert.deepEqual(appelés, ['verification']);
    assert.equal(capabilities.isActive('verification.alert'), false, 'seule l\'alerte se tait');
  });
});
