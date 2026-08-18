import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createAuditCache, verifyAuditActions } from '../../../src/modules/logs/audit.js';
import { AUDIT_ACTION_NAMES } from '../../../src/modules/logs/constants.js';

/**
 * Cache du journal d'audit.
 *
 * Aucun import de discord.js : `fetchEntries` est injecté, et c'est ce qui rend
 * tout ce fichier exécutable sans réseau ni jeton.
 */

const MODERATEUR = '111111111111111111';

const REGLAGES = {
  'logs.audit.correlation_window_seconds': 5,
  'logs.audit.refresh_interval_ms': 2000,
  'logs.audit.fetch_limit': 25,
};

const config = (overrides = {}) => {
  const values = { ...REGLAGES, ...overrides };

  return {
    values,
    get(path, ...fallback) {
      if (Object.hasOwn(this.values, path)) return this.values[path];
      if (fallback.length > 0) return fallback[0];

      throw new Error(`chemin de configuration inconnu : ${path}`);
    },
  };
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
    of: (level) => entries.filter((entry) => entry.level === level),
  };
};

const entry = (patch = {}) => ({
  id: '900000000000000001',
  actionName: 'MessageDelete',
  executorId: MODERATEUR,
  targetId: '123456789012345678',
  channelId: '222222222222222222',
  count: 1,
  createdAt: new Date(),
  ...patch,
});

describe('verifyAuditActions', () => {
  test('accepte une énumération qui connaît tous nos noms', () => {
    const enumeration = Object.fromEntries(AUDIT_ACTION_NAMES.map((name, i) => [name, i + 1]));

    const resolved = verifyAuditActions(enumeration);

    assert.deepEqual(Object.keys(resolved).sort(), [...AUDIT_ACTION_NAMES].sort());
    assert.equal(resolved.MessageDelete, enumeration.MessageDelete);
  });

  test('lève en nommant les actions inconnues', () => {
    // Un nom inconnu produit `undefined` à la résolution, et une requête sur
    // `undefined` ne rend rien : tout un type d'événement passerait en `unknown`
    // sans qu'aucune erreur ne le signale.
    const enumeration = Object.fromEntries(
      AUDIT_ACTION_NAMES.filter((name) => name !== 'MemberBanAdd').map((name) => [name, 1]),
    );

    assert.throws(() => verifyAuditActions(enumeration), /MemberBanAdd/);
    assert.throws(() => verifyAuditActions(enumeration), /divergé de AuditLogEvent/);
  });

  test('refuse une énumération absente', () => {
    assert.throws(() => verifyAuditActions(undefined), /inconnues de la bibliothèque/);
  });

  test('refuse un nom qui ne résout pas vers un entier', () => {
    // `AuditLogEvent` est une énumération compilée : ses valeurs sont des
    // nombres. Une chaîne signalerait qu'on lit la correspondance inverse.
    const enumeration = Object.fromEntries(AUDIT_ACTION_NAMES.map((name) => [name, name]));

    assert.throws(() => verifyAuditActions(enumeration), /inconnues de la bibliothèque/);
  });
});

describe('économie de requêtes', () => {
  test('deux demandes rapprochées ne produisent qu\'un appel', async () => {
    // Une purge de cent messages doit coûter une requête, pas cent.
    let appels = 0;
    const cache = createAuditCache({
      fetchEntries: async () => {
        appels += 1;
        return [entry()];
      },
      config: config(),
      logger: fakeLogger(),
    });

    await cache.entries(['MessageDelete']);
    await cache.entries(['MessageDelete']);
    await cache.entries(['MessageDelete']);

    assert.equal(appels, 1);
  });

  test('deux demandes concurrentes partagent une requête en vol', async () => {
    // Dix événements arrivant dans la même milliseconde produiraient dix
    // requêtes identiques : le cache cesserait de servir précisément quand il
    // sert le plus.
    let appels = 0;
    let liberer;
    const attente = new Promise((resolve) => {
      liberer = resolve;
    });

    const cache = createAuditCache({
      fetchEntries: async () => {
        appels += 1;
        await attente;
        return [entry()];
      },
      config: config(),
      logger: fakeLogger(),
    });

    const promesses = [
      cache.entries(['MessageDelete']),
      cache.entries(['MessageDelete']),
      cache.entries(['MessageDelete']),
    ];

    liberer();

    const resultats = await Promise.all(promesses);

    assert.equal(appels, 1);
    for (const liste of resultats) assert.equal(liste.length, 1);
  });

  test('chaque action a son propre cache', async () => {
    const vues = [];
    const cache = createAuditCache({
      fetchEntries: async ({ actionName }) => {
        vues.push(actionName);
        return [];
      },
      config: config(),
      logger: fakeLogger(),
    });

    await cache.entries(['MessageDelete']);
    await cache.entries(['MemberBanAdd']);

    assert.deepEqual(vues, ['MessageDelete', 'MemberBanAdd']);
    assert.equal(cache.size.actions, 2);
  });

  test('rafraîchit une fois l\'intervalle écoulé', async () => {
    let appels = 0;
    const reglages = config({ 'logs.audit.refresh_interval_ms': 1 });

    const cache = createAuditCache({
      fetchEntries: async () => {
        appels += 1;
        return [];
      },
      config: reglages,
      logger: fakeLogger(),
    });

    await cache.entries(['MessageDelete']);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cache.entries(['MessageDelete']);

    assert.equal(appels, 2);
  });

  test('transmet la limite configurée', async () => {
    let recu = null;
    const cache = createAuditCache({
      fetchEntries: async (query) => {
        recu = query;
        return [];
      },
      config: config({ 'logs.audit.fetch_limit': 7 }),
      logger: fakeLogger(),
    });

    await cache.entries(['MessageDelete']);

    assert.deepEqual(recu, { actionName: 'MessageDelete', limit: 7 });
  });
});

describe('échec de lecture', () => {
  test('rend une liste vide sans jamais lever', async () => {
    // Le journal d'audit est un enrichissement, pas une dépendance : sans lui on
    // écrit `unknown` et on continue.
    const logger = fakeLogger();
    const cache = createAuditCache({
      fetchEntries: async () => {
        throw new Error('Missing Permissions');
      },
      config: config(),
      logger,
    });

    const entries = await cache.entries(['MessageDelete']);

    assert.deepEqual(entries, []);
    assert.equal(logger.of('error').length, 0, 'une permission retirée n\'est pas un défaut du bot');

    const [avertissement] = logger.of('warn');

    assert.match(avertissement.message, /journal d'audit/);
    assert.equal(avertissement.context.action, 'MessageDelete');
  });

  test('n\'insiste pas : une API qui refuse n\'est pas re-sollicitée aussitôt', async () => {
    // Sans cela, une limitation de débit se transformerait en tempête.
    let appels = 0;
    const cache = createAuditCache({
      fetchEntries: async () => {
        appels += 1;
        throw new Error('rate limited');
      },
      config: config(),
      logger: fakeLogger(),
    });

    await cache.entries(['MessageDelete']);
    await cache.entries(['MessageDelete']);
    await cache.entries(['MessageDelete']);

    assert.equal(appels, 1);
  });

  test('écarte ce qu\'il croyait savoir plutôt que de servir une photo périmée', async () => {
    let doitEchouer = false;
    const cache = createAuditCache({
      fetchEntries: async () => {
        if (doitEchouer) throw new Error('réseau');
        return [entry()];
      },
      config: config({ 'logs.audit.refresh_interval_ms': 1 }),
      logger: fakeLogger(),
    });

    assert.equal((await cache.entries(['MessageDelete'])).length, 1);

    doitEchouer = true;
    await new Promise((resolve) => setTimeout(resolve, 5));

    assert.deepEqual(await cache.entries(['MessageDelete']), [], 'en cas de doute, rien');
  });

  test('une liste absente est traitée comme une liste vide', async () => {
    const cache = createAuditCache({
      fetchEntries: async () => undefined,
      config: config(),
      logger: fakeLogger(),
    });

    assert.deepEqual(await cache.entries(['MessageDelete']), []);
  });
});

describe('fenêtre et compteurs', () => {
  const vieille = () => new Date(Date.now() - 60_000);

  test('les entrées hors fenêtre sont écartées', async () => {
    const cache = createAuditCache({
      fetchEntries: async () => [
        entry({ id: 'vieille', createdAt: vieille() }),
        entry({ id: 'recente' }),
      ],
      config: config(),
      logger: fakeLogger(),
    });

    const entries = await cache.entries(['MessageDelete']);

    assert.deepEqual(entries.map((held) => held.id), ['recente']);
  });

  test('une entrée à venir de quelques millisecondes est conservée', async () => {
    // Les horloges de Discord et la nôtre ne sont pas synchronisées.
    const cache = createAuditCache({
      fetchEntries: async () => [entry({ createdAt: new Date(Date.now() + 200) })],
      config: config(),
      logger: fakeLogger(),
    });

    assert.equal((await cache.entries(['MessageDelete'])).length, 1);
  });

  test('une entrée jamais vue est marquée neuve', async () => {
    const cache = createAuditCache({
      fetchEntries: async () => [entry({ count: 3 })],
      config: config(),
      logger: fakeLogger(),
    });

    const [held] = await cache.entries(['MessageDelete']);

    assert.equal(held.isNew, true);
    assert.equal(held.increased, false);
    assert.equal(held.count, 3);
  });

  test('un compteur qui monte est marqué, un compteur figé ne l\'est pas', async () => {
    let count = 1;
    const cache = createAuditCache({
      fetchEntries: async () => [entry({ count })],
      config: config({ 'logs.audit.refresh_interval_ms': 1 }),
      logger: fakeLogger(),
    });

    await cache.entries(['MessageDelete']);

    // Deuxième passage, compteur inchangé : l'entrée est un reste du passage
    // précédent, elle ne correspond à aucun nouvel acte.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [fige] = await cache.entries(['MessageDelete']);

    assert.equal(fige.isNew, false);
    assert.equal(fige.increased, false);

    // Troisième passage, compteur monté : un modérateur a supprimé un message
    // de plus, Discord a incrémenté l'entrée existante.
    count = 2;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [monte] = await cache.entries(['MessageDelete']);

    assert.equal(monte.isNew, false);
    assert.equal(monte.increased, true);
  });

  test('un compteur absent vaut 1', async () => {
    const cache = createAuditCache({
      fetchEntries: async () => [{ ...entry(), count: undefined }],
      config: config(),
      logger: fakeLogger(),
    });

    assert.equal((await cache.entries(['MemberBanAdd']))[0].count, 1);
  });

  test('la carte des compteurs est bornée par la fenêtre', async () => {
    // Sans bornage, un bot qui tourne trois semaines garderait un compteur par
    // entrée d'audit jamais revue.
    let identifiant = 0;
    const cache = createAuditCache({
      fetchEntries: async () => {
        identifiant += 1;
        return [entry({ id: `entree-${identifiant}` })];
      },
      config: config({
        'logs.audit.refresh_interval_ms': 1,
        'logs.audit.correlation_window_seconds': 0,
      }),
      logger: fakeLogger(),
    });

    for (let i = 0; i < 5; i += 1) {
      await cache.entries(['MessageDelete']);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }

    assert.ok(cache.size.counters <= 1, `compteurs retenus : ${cache.size.counters}`);
  });
});

describe('union de plusieurs actions', () => {
  test('rend les entrées de toutes les actions demandées', async () => {
    // Discord distingue création, modification et suppression pour les
    // permissions de salon, alors que la passerelle n'émet qu'un événement.
    const cache = createAuditCache({
      fetchEntries: async ({ actionName }) => [entry({ id: actionName, actionName })],
      config: config(),
      logger: fakeLogger(),
    });

    const entries = await cache.entries([
      'ChannelOverwriteCreate',
      'ChannelOverwriteUpdate',
      'ChannelOverwriteDelete',
    ]);

    assert.deepEqual(entries.map((held) => held.actionName), [
      'ChannelOverwriteCreate',
      'ChannelOverwriteUpdate',
      'ChannelOverwriteDelete',
    ]);
  });

  test('chaque action garde son cache : trois actions, trois requêtes au plus', async () => {
    let appels = 0;
    const cache = createAuditCache({
      fetchEntries: async () => {
        appels += 1;
        return [];
      },
      config: config(),
      logger: fakeLogger(),
    });

    const actions = ['WebhookCreate', 'WebhookUpdate', 'WebhookDelete'];

    await cache.entries(actions);
    await cache.entries(actions);

    assert.equal(appels, 3, 'la seconde demande est servie par les trois caches');
  });

  test('une liste vide ne déclenche aucune requête', async () => {
    let appels = 0;
    const cache = createAuditCache({
      fetchEntries: async () => {
        appels += 1;
        return [];
      },
      config: config(),
      logger: fakeLogger(),
    });

    assert.deepEqual(await cache.entries([]), []);
    assert.equal(appels, 0);
  });

  test('refuse une chaîne : la forme est uniforme', async () => {
    // `AUDIT_ACTIONS` ne rend que des listes. Accepter aussi une chaîne créerait
    // deux chemins là où il n'y a qu'une question.
    const cache = createAuditCache({
      fetchEntries: async () => [],
      config: config(),
      logger: fakeLogger(),
    });

    await assert.rejects(() => cache.entries('MessageDelete'), TypeError);
  });

  test('l\'échec d\'une action n\'emporte pas les autres', async () => {
    const cache = createAuditCache({
      fetchEntries: async ({ actionName }) => {
        if (actionName === 'WebhookUpdate') throw new Error('Missing Permissions');
        return [entry({ id: actionName, actionName })];
      },
      config: config(),
      logger: fakeLogger(),
    });

    const entries = await cache.entries(['WebhookCreate', 'WebhookUpdate', 'WebhookDelete']);

    assert.deepEqual(entries.map((held) => held.actionName), ['WebhookCreate', 'WebhookDelete']);
  });
});

describe('actions à compteur', () => {
  test('les suppressions de messages en sont, pas un bannissement', () => {
    const cache = createAuditCache({
      fetchEntries: async () => [],
      config: config(),
      logger: fakeLogger(),
    });

    assert.equal(cache.isCounted('MessageDelete'), true);
    assert.equal(cache.isCounted('MessageBulkDelete'), true);
    assert.equal(cache.isCounted('MemberBanAdd'), false);
    assert.equal(cache.isCounted('MemberUpdate'), false);
  });
});
