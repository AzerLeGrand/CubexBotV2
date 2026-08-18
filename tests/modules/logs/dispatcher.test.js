import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createDispatcher } from '../../../src/modules/logs/dispatcher.js';

/**
 * File de groupement et envoi.
 *
 * `send` est injecté : aucun import de discord.js, aucun réseau. Le rendeur et
 * le batcher sont factices ici — les vrais sont éprouvés dans leurs propres
 * fichiers — parce que c'est l'ORCHESTRATION qu'on teste.
 */

const SALON_A = '111111111111111111';
const SALON_B = '222222222222222222';

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

const config = (overrides = {}) => {
  const values = {
    'logs.grouping.window_seconds': 0,
    'logs.grouping.compact_threshold': 5,
    ...overrides,
  };

  return {
    values,
    get(path, ...fallback) {
      if (Object.hasOwn(this.values, path)) return this.values[path];
      if (fallback.length > 0) return fallback[0];

      throw new Error(`chemin de configuration inconnu : ${path}`);
    },
  };
};

/** Rendeur factice : il marque le mode employé, ce qui suffit à le distinguer. */
const fakeRenderer = () => {
  const appels = { rich: 0, compact: 0 };

  return {
    appels,
    renderRich: ({ id }) => {
      appels.rich += 1;
      return { embed: { mode: 'rich', id }, attachment: null };
    },
    renderCompact: (records) => {
      appels.compact += 1;
      return { embed: { mode: 'compact', count: records.length }, attachments: [] };
    },
  };
};

/** Batcher factice : un message par embed suffit à observer le découpage. */
const fakeBatcher = ({ perMessage = 10 } = {}) => ({
  splitBatch: (list) => {
    const messages = [];

    for (let i = 0; i < list.length; i += perMessage) {
      messages.push(list.slice(i, i + perMessage));
    }

    return messages;
  },
});

const build = ({ send, reglages = {}, renderer = fakeRenderer(), batcher = fakeBatcher() } = {}) => {
  const logger = fakeLogger();
  const envois = [];

  const dispatcher = createDispatcher({
    send:
      send ??
      (async (message) => {
        envois.push(message);
      }),
    renderer,
    batcher,
    config: config(reglages),
    logger,
  });

  return { dispatcher, envois, logger, renderer };
};

const record = ({ id = 1, channelId = SALON_A, deliverable = true, reason = null } = {}) => ({
  id,
  event: { eventType: 'message_delete' },
  routing: { channelKey: 'messages', channelId, deliverable, reason },
});

/** La fenêtre valant zéro, un tour de boucle d'événements suffit. */
const laisserPasserLaFenetre = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('files par salon', () => {
  test('deux salons sont envoyés indépendamment', async () => {
    // Un salon bruyant ne doit pas retarder les autres : une file unique ferait
    // attendre un bannissement derrière quarante suppressions de messages.
    const { dispatcher, envois } = build();

    dispatcher.enqueue(record({ id: 1, channelId: SALON_A }));
    dispatcher.enqueue(record({ id: 2, channelId: SALON_B }));

    assert.deepEqual(dispatcher.channels, [SALON_A, SALON_B]);

    await dispatcher.flush();

    assert.deepEqual(envois.map((held) => held.channelId).sort(), [SALON_A, SALON_B]);
  });

  test('un échec sur un salon n\'empêche pas l\'autre', async () => {
    const recus = [];

    const { dispatcher, logger } = build({
      send: async ({ channelId }) => {
        if (channelId === SALON_A) throw new Error('Missing Access');
        recus.push(channelId);
      },
    });

    dispatcher.enqueue(record({ channelId: SALON_A }));
    dispatcher.enqueue(record({ channelId: SALON_B }));

    await dispatcher.flush();

    assert.deepEqual(recus, [SALON_B]);
    assert.equal(logger.of('warn').length, 1);
  });

  test('size compte tous les salons confondus', () => {
    const { dispatcher } = build({ reglages: { 'logs.grouping.window_seconds': 60 } });

    dispatcher.enqueue(record({ channelId: SALON_A }));
    dispatcher.enqueue(record({ channelId: SALON_A }));
    dispatcher.enqueue(record({ channelId: SALON_B }));

    assert.equal(dispatcher.size, 3);
  });
});

describe('fenêtre de groupement', () => {
  test('un événement isolé part après la fenêtre', async () => {
    // Le groupement s'applique à TOUS les salons, y compris pour un événement
    // seul. Le léger délai est accepté par la spec §5.
    const { dispatcher, envois } = build();

    dispatcher.enqueue(record());

    assert.equal(envois.length, 0, 'rien n\'est parti immédiatement');
    assert.equal(dispatcher.size, 1);

    await laisserPasserLaFenetre();

    assert.equal(envois.length, 1);
    assert.equal(dispatcher.size, 0);
  });

  test('les événements d\'une même fenêtre partent ensemble', async () => {
    const { dispatcher, envois } = build();

    dispatcher.enqueue(record({ id: 1 }));
    dispatcher.enqueue(record({ id: 2 }));
    dispatcher.enqueue(record({ id: 3 }));

    await laisserPasserLaFenetre();

    assert.equal(envois.length, 1, 'un seul message');
    assert.equal(envois[0].embeds.length, 3);
  });

  test('une modification de window_seconds est prise en compte', async () => {
    // La fenêtre est lue à CHAQUE ouverture, jamais au montage : un `/reload`
    // doit prendre effet sans redémarrage.
    const reglages = config({ 'logs.grouping.window_seconds': 60 });
    const envois = [];

    const dispatcher = createDispatcher({
      send: async (message) => {
        envois.push(message);
      },
      renderer: fakeRenderer(),
      batcher: fakeBatcher(),
      config: reglages,
      logger: fakeLogger(),
    });

    dispatcher.enqueue(record());

    await laisserPasserLaFenetre();

    assert.equal(envois.length, 0, 'la fenêtre longue tient encore');

    await dispatcher.flush();

    reglages.values['logs.grouping.window_seconds'] = 0;

    dispatcher.enqueue(record({ id: 2 }));

    await laisserPasserLaFenetre();

    assert.equal(envois.length, 2, 'la nouvelle fenêtre a été relue');
  });
});

describe('choix du rendu', () => {
  test('en dessous du seuil, un embed riche par événement', async () => {
    const renderer = fakeRenderer();
    const { dispatcher, envois } = build({ renderer });

    for (let i = 0; i < 5; i += 1) dispatcher.enqueue(record({ id: i }));

    await laisserPasserLaFenetre();

    assert.equal(renderer.appels.rich, 5);
    assert.equal(renderer.appels.compact, 0);
    assert.equal(envois[0].embeds.length, 5);
  });

  test('au-delà du seuil, rendu condensé', async () => {
    // Une purge de cent messages produirait sinon dix messages de dix embeds.
    const renderer = fakeRenderer();
    const { dispatcher, envois } = build({ renderer });

    for (let i = 0; i < 6; i += 1) dispatcher.enqueue(record({ id: i }));

    await laisserPasserLaFenetre();

    assert.equal(renderer.appels.compact, 1);
    assert.equal(renderer.appels.rich, 0);
    assert.equal(envois[0].embeds.length, 1, 'un embed unique pour tout le lot');
    assert.equal(envois[0].embeds[0].count, 6);
  });

  test('le seuil suit la configuration', async () => {
    const renderer = fakeRenderer();
    const { dispatcher } = build({
      renderer,
      reglages: { 'logs.grouping.compact_threshold': 2 },
    });

    for (let i = 0; i < 3; i += 1) dispatcher.enqueue(record({ id: i }));

    await laisserPasserLaFenetre();

    assert.equal(renderer.appels.compact, 1);
  });
});

describe('salon injoignable', () => {
  test('rien n\'est mis en file, et rien n\'échoue', async () => {
    // La ligne est déjà en base : c'est la garantie tenue depuis le lot 2.
    // Accumuler pour un salon qui n'existe plus ferait croître la mémoire sans
    // jamais rien afficher.
    const { dispatcher, envois, logger } = build();

    dispatcher.enqueue(record({ deliverable: false, reason: 'salon introuvable' }));

    assert.equal(dispatcher.size, 0);
    assert.deepEqual(dispatcher.channels, []);

    await laisserPasserLaFenetre();

    assert.equal(envois.length, 0);
    assert.equal(logger.of('warn').length, 0);
    assert.equal(logger.of('error').length, 0);

    const [trace] = logger.of('debug');

    assert.equal(trace.context.reason, 'salon introuvable');
  });

  test('un retour nul de record() est ignoré sans bruit', async () => {
    // `record()` rend `null` sur un événement désactivé, écarté ou exclu.
    const { dispatcher, logger } = build();

    assert.doesNotThrow(() => dispatcher.enqueue(null));
    assert.doesNotThrow(() => dispatcher.enqueue(undefined));
    assert.equal(dispatcher.size, 0);
    assert.deepEqual(logger.entries, []);
  });
});

describe('échec d\'envoi', () => {
  test('journalisé en warn et ABANDONNÉ, jamais retenté', async () => {
    // La donnée n'est pas perdue, elle est en base. Réessayer après un
    // redémarrage produirait des doublons impossibles à distinguer.
    let appels = 0;

    const { dispatcher, logger } = build({
      send: async () => {
        appels += 1;
        throw new Error('Missing Permissions');
      },
    });

    dispatcher.enqueue(record());

    await laisserPasserLaFenetre();
    await laisserPasserLaFenetre();

    assert.equal(appels, 1, 'un seul essai');
    assert.equal(dispatcher.size, 0, 'la file est vidée malgré l\'échec');

    const [avertissement] = logger.of('warn');

    assert.match(avertissement.message, /envoi vers un salon/);
    assert.equal(logger.of('error').length, 0, 'un salon supprimé n\'est pas un défaut du bot');
  });

  test('un échec de rendu n\'emporte pas le dispatcher', async () => {
    const { dispatcher, logger } = build({
      renderer: {
        renderRich: () => {
          throw new Error('gabarit absent');
        },
        renderCompact: () => {
          throw new Error('gabarit absent');
        },
      },
    });

    dispatcher.enqueue(record());

    await laisserPasserLaFenetre();

    assert.equal(logger.of('error').length, 1);
    assert.equal(dispatcher.size, 0);

    // Et la file reste utilisable.
    assert.doesNotThrow(() => dispatcher.enqueue(record({ id: 2 })));
  });
});

describe('découpage', () => {
  test('un appel à send par message produit', async () => {
    const { dispatcher, envois } = build({
      batcher: fakeBatcher({ perMessage: 2 }),
      reglages: { 'logs.grouping.compact_threshold': 99 },
    });

    for (let i = 0; i < 5; i += 1) dispatcher.enqueue(record({ id: i }));

    await laisserPasserLaFenetre();

    assert.equal(envois.length, 3, '5 embeds découpés par 2');
    assert.deepEqual(envois.map((held) => held.embeds.length), [2, 2, 1]);
  });

  test('les pièces jointes accompagnent le premier message', async () => {
    // Les répartir demanderait de savoir quel embed a produit quel fichier, une
    // correspondance que le découpage par budget ne conserve pas.
    const fichier = { name: 'x.txt', content: 'y' };

    const { dispatcher, envois } = build({
      batcher: fakeBatcher({ perMessage: 1 }),
      renderer: {
        renderRich: ({ id }) => ({ embed: { id }, attachment: fichier }),
        renderCompact: () => ({ embed: {}, attachments: [] }),
      },
      reglages: { 'logs.grouping.compact_threshold': 99 },
    });

    dispatcher.enqueue(record({ id: 1 }));
    dispatcher.enqueue(record({ id: 2 }));

    await laisserPasserLaFenetre();

    assert.equal(envois.length, 2);
    assert.equal(envois[0].attachments.length, 2);
    assert.deepEqual(envois[1].attachments, []);
  });
});

describe('flush', () => {
  test('envoie immédiatement, sans attendre la fenêtre', async () => {
    const { dispatcher, envois } = build({
      reglages: { 'logs.grouping.window_seconds': 3600 },
    });

    dispatcher.enqueue(record({ channelId: SALON_A }));
    dispatcher.enqueue(record({ channelId: SALON_B }));

    await dispatcher.flush();

    assert.equal(envois.length, 2);
    assert.equal(dispatcher.size, 0);
  });

  test('sur une file vide, ne fait rien et ne lève pas', async () => {
    const { dispatcher, envois } = build();

    await assert.doesNotReject(() => dispatcher.flush());

    assert.equal(envois.length, 0);
  });

  test('rend une promesse résolue quand tout est parti', async () => {
    let termine = false;

    const { dispatcher } = build({
      send: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        termine = true;
      },
      reglages: { 'logs.grouping.window_seconds': 3600 },
    });

    dispatcher.enqueue(record());

    await dispatcher.flush();

    assert.equal(termine, true, 'flush attend réellement l\'envoi');
  });
});
