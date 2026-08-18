import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ACTOR_CONFIDENCE, EVENT_SOURCE } from '../../../src/modules/logs/constants.js';
import { createLogEvent } from '../../../src/modules/logs/event.js';
import { createExclusions } from '../../../src/modules/logs/exclusions.js';

/**
 * Filtrage par exclusions (spec §4).
 *
 * L'exclusion porte sur l'AUTEUR DE L'ACTION, jamais sur le message concerné.
 * Le tableau de la spec est contre-intuitif, et ces tests le reproduisent ligne
 * par ligne — c'est leur seule raison d'être.
 */

const BOT = '444444444444444444';
const MEMBRE = '123456789012345678';
const MODERATEUR = '111111111111111111';
const BOT_TIERS = '555555555555555555';
const SALON_EXCLU = '222222222222222222';
const SALON = '666666666666666666';
const ROLE_EXCLU = '777777777777777777';

const AT = new Date(Date.UTC(2026, 7, 18, 14, 32, 7, 512));

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
    'logs.exclusions.channels': [],
    'logs.exclusions.users': [],
    'logs.exclusions.roles': [],
    ...overrides,
  };

  return {
    get(path, ...fallback) {
      if (Object.hasOwn(values, path)) return values[path];
      if (fallback.length > 0) return fallback[0];

      throw new Error(`chemin de configuration inconnu : ${path}`);
    },
  };
};

const build = ({ reglages = {}, roles = {}, botUserId = BOT, logger = fakeLogger() } = {}) => ({
  logger,
  exclusions: createExclusions({
    config: config(reglages),
    resolveRoles: async (userId) => roles[userId] ?? [],
    botUserId: () => botUserId,
    logger,
  }),
});

const event = (patch = {}) =>
  createLogEvent({
    type: 'message_delete',
    occurredAt: AT,
    actorId: null,
    actorConfidence: ACTOR_CONFIDENCE.unknown,
    targetId: MEMBRE,
    channelId: SALON,
    source: EVENT_SOURCE.live,
    ...patch,
  });

describe('le tableau du §4, ligne par ligne', () => {
  test('le bot écrit un log : non journalisé', async () => {
    const { exclusions } = build();

    const exclu = await exclusions.isExcluded(
      event({ targetId: BOT, channelId: SALON_EXCLU }),
      { actorId: null },
    );

    assert.equal(exclu, true);
  });

  test('un modérateur supprime un message du bot : JOURNALISÉ', async () => {
    // Le raccourci ne vaut que pour une modification. Une suppression d'un
    // message du bot par un tiers est exactement ce qu'on veut voir.
    const { exclusions } = build();

    const exclu = await exclusions.isExcluded(event({ targetId: BOT }), { actorId: MODERATEUR });

    assert.equal(exclu, false);
  });

  test('un membre écrit dans un salon exclu : non journalisé', async () => {
    const { exclusions } = build({
      reglages: { 'logs.exclusions.channels': [SALON_EXCLU] },
    });

    const exclu = await exclusions.isExcluded(event({ channelId: SALON_EXCLU }), { actorId: null });

    assert.equal(exclu, true);
  });

  test('un modérateur supprime un message dans un salon exclu : JOURNALISÉ', async () => {
    // Un filtrage sur le salon rendrait invisibles les actions des modérateurs
    // là où on les surveille le moins.
    const { exclusions } = build({
      reglages: { 'logs.exclusions.channels': [SALON_EXCLU] },
    });

    const exclu = await exclusions.isExcluded(event({ channelId: SALON_EXCLU }), {
      actorId: MODERATEUR,
    });

    assert.equal(exclu, false);
  });
});

describe('exclusion du bot, sans configuration', () => {
  test('le bot est exclu sans figurer dans logs.exclusions.users', async () => {
    // Une garantie structurelle ne doit pas dépendre d'une valeur éditable :
    // une liste vidée pour un test lèverait la protection en silence.
    const { exclusions } = build();

    assert.deepEqual(config().get('logs.exclusions.users'), []);
    assert.equal(await exclusions.isExcluded(event(), { actorId: BOT }), true);
    assert.equal(await exclusions.isExcluded(event({ targetId: BOT }), { actorId: null }), true);
  });

  test('sans identité du bot injectée, plus personne n\'est exclu de ce chef', async () => {
    // Mode dégradé entre `init()` et `attach()` : mieux vaut journaliser de trop
    // que d'ignorer à tort.
    const { exclusions } = build({ botUserId: null });

    assert.equal(exclusions.hasSelfId, false);
    assert.equal(await exclusions.isExcluded(event(), { actorId: BOT }), false);
  });
});

describe('raccourci de la modification', () => {
  test('message_edit du bot est écarté', async () => {
    const { exclusions } = build();

    const modification = event({
      type: 'message_edit',
      actorId: BOT,
      actorConfidence: ACTOR_CONFIDENCE.certain,
      content: { authorId: BOT, before: 'avant', after: 'après' },
    });

    assert.equal(exclusions.isBotSelfEdit(modification), true);
  });

  test('message_delete du bot N\'EST PAS écarté par le raccourci', async () => {
    // La ligne entre « le bot se tait sur lui-même » et « le bot cache les
    // actions du staff ».
    const { exclusions } = build();

    const suppression = event({ content: { authorId: BOT, before: 'un log' } });

    assert.equal(exclusions.isBotSelfEdit(suppression), false);
  });

  test('la modification d\'un membre n\'est pas écartée', async () => {
    const { exclusions } = build();

    const modification = event({
      type: 'message_edit',
      actorId: MEMBRE,
      actorConfidence: ACTOR_CONFIDENCE.certain,
      content: { authorId: MEMBRE, before: 'a', after: 'b' },
    });

    assert.equal(exclusions.isBotSelfEdit(modification), false);
  });

  test('ne s\'applique qu\'à message_edit', () => {
    const { exclusions } = build();

    assert.deepEqual(exclusions.selfEditTypes, ['message_edit']);
  });
});

describe('comptes et rôles exclus', () => {
  test('un bot tiers bavard s\'exclut par la configuration', async () => {
    const { exclusions } = build({
      reglages: { 'logs.exclusions.users': [BOT_TIERS] },
    });

    assert.equal(await exclusions.isExcluded(event(), { actorId: BOT_TIERS }), true);
    assert.equal(await exclusions.isExcluded(event({ targetId: BOT_TIERS }), {}), true);
  });

  test('un rôle exclu écarte celui qui le porte', async () => {
    const { exclusions } = build({
      reglages: { 'logs.exclusions.roles': [ROLE_EXCLU] },
      roles: { [BOT_TIERS]: [ROLE_EXCLU] },
    });

    assert.equal(await exclusions.isExcluded(event(), { actorId: BOT_TIERS }), true);
    assert.equal(await exclusions.isExcluded(event(), { actorId: MODERATEUR }), false);
  });

  test('aucune requête de rôles quand la liste des rôles exclus est vide', async () => {
    let appels = 0;

    const exclusions = createExclusions({
      config: config(),
      resolveRoles: async () => {
        appels += 1;
        return [];
      },
      botUserId: () => BOT,
      logger: fakeLogger(),
    });

    await exclusions.isExcluded(event(), { actorId: MODERATEUR });

    assert.equal(appels, 0, 'le cas courant ne doit rien coûter');
  });

  test('l\'auteur du message sert de sujet quand la cible manque', async () => {
    const { exclusions } = build({
      reglages: { 'logs.exclusions.users': [BOT_TIERS] },
    });

    const sansCible = event({ targetId: null, content: { authorId: BOT_TIERS, before: 'x' } });

    assert.equal(await exclusions.isExcluded(sansCible, { actorId: null }), true);
  });
});

describe('échec de résolution des rôles', () => {
  test('n\'exclut pas, et journalise en warn', async () => {
    // Ignorer un événement à tort le fait disparaître sans laisser de trace ;
    // en journaliser un de trop se corrige en lisant le salon.
    const logger = fakeLogger();

    const exclusions = createExclusions({
      config: config({ 'logs.exclusions.roles': [ROLE_EXCLU] }),
      resolveRoles: async () => {
        throw new Error('membre introuvable');
      },
      botUserId: () => BOT,
      logger,
    });

    assert.equal(await exclusions.isExcluded(event(), { actorId: MODERATEUR }), false);
    assert.equal(logger.of('warn').length, 1);
    assert.equal(logger.of('error').length, 0);
  });

  test('un resolveRoles absent est traité comme « pas de rôle »', async () => {
    const exclusions = createExclusions({
      config: config({ 'logs.exclusions.roles': [ROLE_EXCLU] }),
      resolveRoles: null,
      botUserId: () => BOT,
      logger: fakeLogger(),
    });

    assert.equal(await exclusions.isExcluded(event(), { actorId: MODERATEUR }), false);
  });

  test('une liste de rôles absente vaut liste vide', async () => {
    const exclusions = createExclusions({
      config: config({ 'logs.exclusions.roles': [ROLE_EXCLU] }),
      resolveRoles: async () => undefined,
      botUserId: () => BOT,
      logger: fakeLogger(),
    });

    assert.equal(await exclusions.isExcluded(event(), { actorId: MODERATEUR }), false);
  });
});

describe('cas neutres', () => {
  test('rien d\'exclu, rien n\'est écarté', async () => {
    const { exclusions } = build();

    assert.equal(await exclusions.isExcluded(event(), { actorId: MODERATEUR }), false);
    assert.equal(await exclusions.isExcluded(event(), { actorId: null }), false);
  });

  test('un événement sans salon ni sujet n\'est jamais écarté par erreur', async () => {
    const { exclusions } = build({
      reglages: { 'logs.exclusions.channels': [SALON_EXCLU] },
    });

    const global = event({ type: 'guild_update', targetId: null, channelId: null, content: null });

    assert.equal(await exclusions.isExcluded(global, { actorId: null }), false);
  });

  test('l\'attribution manquante est traitée comme aucun auteur', async () => {
    const { exclusions } = build({
      reglages: { 'logs.exclusions.users': [MEMBRE] },
    });

    assert.equal(await exclusions.isExcluded(event()), true, 'appel sans second argument');
  });
});
