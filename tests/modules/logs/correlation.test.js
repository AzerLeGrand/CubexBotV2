import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ACTOR_CONFIDENCE,
  AUDIT_ACTIONS,
  COUNTED_AUDIT_ACTIONS,
  EVENT_SOURCE,
  LOG_EVENTS,
  TYPE_PROMOTIONS,
} from '../../../src/modules/logs/constants.js';
import { createCorrelator } from '../../../src/modules/logs/correlation.js';
import { createLogEvent } from '../../../src/modules/logs/event.js';

/**
 * Attribution de l'auteur d'une action.
 *
 * La partie la plus délicate du module : une attribution fausse s'affiche
 * exactement comme une bonne, personne ne la remarque, et elle alimentera le
 * casier de la phase 3. Les tests portent donc surtout sur ce qui NE doit PAS
 * être attribué.
 */

const MEMBRE = '123456789012345678';
const MODERATEUR = '111111111111111111';
const AUTRE_MOD = '333333333333333333';
const SALON = '222222222222222222';

const AT = new Date(Date.UTC(2026, 7, 18, 14, 32, 7, 512));

const config = (overrides = {}) => {
  const values = { 'logs.audit.correlation_window_seconds': 5, ...overrides };

  return {
    get(path, ...fallback) {
      if (Object.hasOwn(values, path)) return values[path];
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

/** Cache factice : le vrai est éprouvé dans audit.test.js. */
const fakeCache = (entries = [], { counted = COUNTED_AUDIT_ACTIONS } = {}) => {
  const demandes = [];

  return {
    demandes,
    entries: async (actionNames) => {
      demandes.push(...actionNames);
      return typeof entries === 'function' ? entries(actionNames) : entries;
    },
    isCounted: (actionName) => counted.includes(actionName),
  };
};

const entry = (patch = {}) => ({
  id: '900000000000000001',
  actionName: 'MessageDelete',
  executorId: MODERATEUR,
  targetId: MEMBRE,
  channelId: SALON,
  count: 1,
  createdAt: AT,
  isNew: true,
  increased: false,
  ...patch,
});

/** Événement normalisé, sans auteur : le cas que la corrélation doit trancher. */
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

const correlator = (cache, reglages) =>
  createCorrelator({ auditCache: cache, config: config(reglages), logger: fakeLogger() });

describe('types sans action d\'audit', () => {
  test('ne déclenchent aucune requête', async () => {
    const cache = fakeCache([entry()]);

    // message_edit : seul l'auteur peut modifier son message, Discord n'inscrit
    // rien. L'acteur est connu sans rien demander à personne.
    await correlator(cache).resolve(
      event({
        type: 'message_edit',
        actorId: MEMBRE,
        actorConfidence: ACTOR_CONFIDENCE.certain,
      }),
    );

    assert.deepEqual(cache.demandes, []);
  });

  test('rendent ce que l\'appelant a établi', async () => {
    const verdict = await correlator(fakeCache()).resolve(
      event({
        type: 'message_edit',
        actorId: MEMBRE,
        actorConfidence: ACTOR_CONFIDENCE.certain,
      }),
    );

    assert.deepEqual(verdict, {
      actorId: MEMBRE,
      actorConfidence: ACTOR_CONFIDENCE.certain,
      promotedType: null,
    });
  });

  test('rendent unknown quand l\'appelant n\'a rien établi', async () => {
    const verdict = await correlator(fakeCache()).resolve(
      event({ type: 'voice_join', channelId: SALON }),
    );

    assert.deepEqual(verdict, {
      actorId: null,
      actorConfidence: ACTOR_CONFIDENCE.unknown,
      promotedType: null,
    });
  });

  test('la table couvre les 33 types, et six d\'entre eux sans action', () => {
    assert.deepEqual(Object.keys(AUDIT_ACTIONS).sort(), [...LOG_EVENTS].sort());

    const sans = Object.entries(AUDIT_ACTIONS)
      .filter(([, actions]) => actions.length === 0)
      .map(([type]) => type);

    assert.deepEqual(sans, [
      'message_edit',
      'voice_join',
      'voice_leave',
      'voice_move',
      'member_join',
      'automod_action',
    ]);
  });
});

describe('un acteur déjà certain', () => {
  test('n\'est jamais dégradé en probable', async () => {
    // Corréler ne pourrait que remplacer un signal fort par un signal faible.
    // Ce n'est pas un repli, c'est le refus d'en fabriquer un.
    const cache = fakeCache([entry({ executorId: AUTRE_MOD })]);

    const verdict = await correlator(cache).resolve(
      event({ actorId: MEMBRE, actorConfidence: ACTOR_CONFIDENCE.certain }),
    );

    assert.deepEqual(verdict, {
      actorId: MEMBRE,
      actorConfidence: ACTOR_CONFIDENCE.certain,
      promotedType: null,
    });
    assert.deepEqual(cache.demandes, [], 'aucune requête dépensée');
  });
});

describe('nombre de candidates', () => {
  test('zéro candidate rend unknown', async () => {
    // Discord n'inscrit RIEN quand un membre supprime son propre message :
    // l'absence d'entrée est le cas le plus fréquent, pas une anomalie.
    const verdict = await correlator(fakeCache([])).resolve(event());

    assert.deepEqual(verdict, {
      actorId: null,
      actorConfidence: ACTOR_CONFIDENCE.unknown,
      promotedType: null,
    });
  });

  test('une candidate rend probable, avec le bon exécuteur', async () => {
    const verdict = await correlator(fakeCache([entry({ executorId: MODERATEUR })])).resolve(event());

    assert.deepEqual(verdict, {
      actorId: MODERATEUR,
      actorConfidence: ACTOR_CONFIDENCE.probable,
      promotedType: null,
    });
  });

  test('DEUX candidates rendent unknown, jamais la plus proche', async () => {
    // Le cœur du lot. Choisir la plus proche dans le temps serait un repli
    // implicite, et il aurait l'air de marcher : deux modérateurs agissant dans
    // la même seconde produiraient une attribution nette et fausse.
    const cache = fakeCache([
      entry({ id: 'a', executorId: MODERATEUR, createdAt: new Date(AT.getTime() + 3000) }),
      entry({ id: 'b', executorId: AUTRE_MOD, createdAt: new Date(AT.getTime() + 10) }),
    ]);

    const verdict = await correlator(cache).resolve(event());

    assert.equal(verdict.actorConfidence, ACTOR_CONFIDENCE.unknown);
    assert.equal(verdict.actorId, null, 'ni la plus proche, ni la première, ni la dernière');
  });

  test('jamais certain : la corrélation ne produit que probable ou unknown', async () => {
    for (const entries of [[], [entry()], [entry({ id: 'a' }), entry({ id: 'b' })]]) {
      const verdict = await correlator(fakeCache(entries)).resolve(event());

      assert.notEqual(verdict.actorConfidence, ACTOR_CONFIDENCE.certain);
    }
  });

  test('une entrée sans exécuteur rend unknown', async () => {
    const verdict = await correlator(fakeCache([entry({ executorId: null })])).resolve(event());

    assert.deepEqual(verdict, {
      actorId: null,
      actorConfidence: ACTOR_CONFIDENCE.unknown,
      promotedType: null,
    });
  });
});

describe('critères de candidature', () => {
  test('une entrée hors fenêtre n\'est pas candidate', async () => {
    const cache = fakeCache([entry({ createdAt: new Date(AT.getTime() + 6000) })]);

    const verdict = await correlator(cache).resolve(event());

    assert.equal(verdict.actorConfidence, ACTOR_CONFIDENCE.unknown);
  });

  test('la fenêtre joue des deux côtés de l\'événement', async () => {
    for (const decalage of [-4000, -10, 10, 4000]) {
      const cache = fakeCache([entry({ createdAt: new Date(AT.getTime() + decalage) })]);
      const verdict = await correlator(cache).resolve(event());

      assert.equal(verdict.actorId, MODERATEUR, `décalage ${decalage} ms`);
    }
  });

  test('la fenêtre suit la configuration', async () => {
    const cache = fakeCache([entry({ createdAt: new Date(AT.getTime() + 8000) })]);

    assert.equal((await correlator(cache).resolve(event())).actorId, null);

    const large = correlator(cache, { 'logs.audit.correlation_window_seconds': 10 });

    assert.equal((await large.resolve(event())).actorId, MODERATEUR);
  });

  test('une cible différente n\'est pas candidate', async () => {
    const cache = fakeCache([entry({ targetId: AUTRE_MOD })]);

    assert.equal((await correlator(cache).resolve(event())).actorId, null);
  });

  test('un salon différent n\'est pas candidat quand l\'événement en a un', async () => {
    const cache = fakeCache([entry({ channelId: '999999999999999999' })]);

    assert.equal((await correlator(cache).resolve(event())).actorId, null);
  });

  test('le salon n\'est pas exigé quand l\'événement n\'en a pas', async () => {
    // Un bannissement n'a pas de salon : l'exiger écarterait toutes les entrées.
    const cache = fakeCache([entry({ actionName: 'MemberBanAdd', channelId: null })]);

    const verdict = await correlator(cache).resolve(
      event({ type: 'member_ban', channelId: null }),
    );

    assert.equal(verdict.actorId, MODERATEUR);
  });

  test('interroge l\'action déclarée dans la table', async () => {
    const cache = fakeCache([]);

    await correlator(cache).resolve(event({ type: 'member_ban', channelId: null }));
    await correlator(cache).resolve(event({ type: 'member_timeout', channelId: null }));

    assert.deepEqual(cache.demandes, ['MemberBanAdd', 'MemberUpdate']);
  });
});

describe('actions à compteur', () => {
  test('une entrée dont le compteur n\'a pas bougé n\'est pas candidate', async () => {
    // Sans ce filtre, l'entrée d'une suppression déjà traitée serait recollée à
    // chaque nouvel événement du même modérateur.
    const cache = fakeCache([entry({ isNew: false, increased: false })]);

    const verdict = await correlator(cache).resolve(event());

    assert.deepEqual(verdict, {
      actorId: null,
      actorConfidence: ACTOR_CONFIDENCE.unknown,
      promotedType: null,
    });
  });

  test('une entrée neuve ou incrémentée est candidate', async () => {
    for (const marque of [{ isNew: true, increased: false }, { isNew: false, increased: true }]) {
      const cache = fakeCache([entry(marque)]);

      assert.equal(
        (await correlator(cache).resolve(event())).actorId,
        MODERATEUR,
        JSON.stringify(marque),
      );
    }
  });

  test('le filtre ne s\'applique pas aux actions sans compteur', async () => {
    // Un bannissement produit une entrée par acte : la marque de fraîcheur n'y
    // veut rien dire, et l'exiger écarterait des attributions parfaitement
    // valides.
    const cache = fakeCache([
      entry({ actionName: 'MemberBanAdd', channelId: null, isNew: false, increased: false }),
    ]);

    const verdict = await correlator(cache).resolve(event({ type: 'member_ban', channelId: null }));

    assert.equal(verdict.actorId, MODERATEUR);
  });
});

describe('plusieurs actions pour un type', () => {
  test('une permission CRÉÉE est attribuée', async () => {
    // N'interroger que ChannelOverwriteUpdate rendait `unknown` sur les deux
    // gestes les plus courants : ajouter et retirer une permission.
    const cache = fakeCache([
      entry({ actionName: 'ChannelOverwriteCreate', targetId: SALON, channelId: null }),
    ]);

    const verdict = await correlator(cache).resolve(
      event({ type: 'channel_permissions_update', correlationTargetId: SALON, channelId: null }),
    );

    assert.equal(verdict.actorId, MODERATEUR);
    assert.equal(verdict.actorConfidence, ACTOR_CONFIDENCE.probable);
  });

  test('un webhook CRÉÉ est attribué', async () => {
    // Discord n'émet qu'un seul événement de passerelle pour les webhooks, sans
    // dire lequel a changé : le journal d'audit est le seul moyen de le savoir.
    const cache = fakeCache([
      entry({ actionName: 'WebhookCreate', targetId: null, channelId: SALON }),
    ]);

    const verdict = await correlator(cache).resolve(
      event({ type: 'webhook_update', targetId: null, channelId: SALON }),
    );

    assert.equal(verdict.actorId, MODERATEUR);
  });

  test('les trois actions sont demandées au cache', async () => {
    const cache = fakeCache([]);

    await correlator(cache).resolve(
      event({ type: 'webhook_update', targetId: null, channelId: SALON }),
    );

    assert.deepEqual(cache.demandes, ['WebhookCreate', 'WebhookUpdate', 'WebhookDelete']);
  });

  test('deux entrées dans deux actions différentes restent deux candidates', async () => {
    // Le comptage porte sur l'UNION : une permission créée et une supprimée dans
    // la même seconde rendent l'attribution indécidable.
    const cache = fakeCache([
      entry({
        id: 'a',
        actionName: 'ChannelOverwriteCreate',
        executorId: MODERATEUR,
        targetId: SALON,
        channelId: null,
      }),
      entry({
        id: 'b',
        actionName: 'ChannelOverwriteDelete',
        executorId: AUTRE_MOD,
        targetId: SALON,
        channelId: null,
      }),
    ]);

    const verdict = await correlator(cache).resolve(
      event({ type: 'channel_permissions_update', correlationTargetId: SALON, channelId: null }),
    );

    assert.equal(verdict.actorConfidence, ACTOR_CONFIDENCE.unknown);
    assert.equal(verdict.actorId, null);
  });

  test('le filtre de compteur porte sur l\'action de chaque entrée', async () => {
    // Une union peut mêler une action à compteur et une autre sans : appliquer
    // le filtre à toutes écarterait des attributions valides.
    const cache = fakeCache([
      entry({ actionName: 'WebhookCreate', targetId: null, channelId: SALON, isNew: false }),
    ]);

    const verdict = await correlator(cache).resolve(
      event({ type: 'webhook_update', targetId: null, channelId: SALON }),
    );

    assert.equal(verdict.actorId, MODERATEUR, 'WebhookCreate n\'est pas une action à compteur');
  });
});

describe('cible de corrélation', () => {
  test('correlationTargetId prime sur targetId', async () => {
    // `target_id` est déclaré au registre d'effacement comme colonne de MEMBRE :
    // y écrire un identifiant de rôle lui donnerait deux sens.
    const ROLE = '888888888888888888';
    const cache = fakeCache([entry({ actionName: 'RoleCreate', targetId: ROLE, channelId: null })]);

    const verdict = await correlator(cache).resolve(
      event({
        type: 'role_create',
        targetId: null,
        correlationTargetId: ROLE,
        channelId: null,
      }),
    );

    assert.equal(verdict.actorId, MODERATEUR);
  });

  test('sans correlationTargetId, la comparaison retombe sur targetId', async () => {
    const cache = fakeCache([entry({ targetId: MEMBRE })]);

    assert.equal((await correlator(cache).resolve(event())).actorId, MODERATEUR);
  });

  test('un correlationTargetId qui ne correspond pas écarte l\'entrée', async () => {
    const cache = fakeCache([entry({ actionName: 'RoleCreate', targetId: '999999999999999999' })]);

    const verdict = await correlator(cache).resolve(
      event({
        type: 'role_create',
        targetId: null,
        correlationTargetId: '888888888888888888',
        channelId: null,
      }),
    );

    assert.equal(verdict.actorId, null);
  });

  test('n\'est jamais rendu par le verdict : il ne doit pas être persisté', async () => {
    const cache = fakeCache([entry()]);

    const verdict = await correlator(cache).resolve(event({ correlationTargetId: MEMBRE }));

    assert.equal(verdict.correlationTargetId, undefined);
  });
});

describe('promotion de type', () => {
  const depart = (patch = {}) =>
    event({ type: 'member_leave', channelId: null, targetId: MEMBRE, ...patch });

  test('une candidate unique promeut member_leave en member_kick', async () => {
    // Départ et expulsion sont le même signal de passerelle : seule une entrée
    // d'audit récente les sépare.
    const cache = fakeCache([
      entry({ actionName: 'MemberKick', targetId: MEMBRE, channelId: null }),
    ]);

    const verdict = await correlator(cache).resolve(depart());

    assert.equal(verdict.promotedType, 'member_kick');
    assert.equal(verdict.actorId, MODERATEUR);
    assert.equal(verdict.actorConfidence, ACTOR_CONFIDENCE.probable);
  });

  test('aucune candidate ne promeut rien : c\'est un départ volontaire', async () => {
    const verdict = await correlator(fakeCache([])).resolve(depart());

    assert.equal(verdict.promotedType, null);
    assert.equal(verdict.actorId, null);
  });

  test('DEUX candidates ne promeuvent pas', async () => {
    // Un départ mal attribué en expulsion irait dans le salon de modération et
    // alimenterait un casier à tort.
    const cache = fakeCache([
      entry({ id: 'a', actionName: 'MemberKick', targetId: MEMBRE, channelId: null }),
      entry({
        id: 'b',
        actionName: 'MemberKick',
        executorId: AUTRE_MOD,
        targetId: MEMBRE,
        channelId: null,
      }),
    ]);

    const verdict = await correlator(cache).resolve(depart());

    assert.equal(verdict.promotedType, null);
    assert.equal(verdict.actorConfidence, ACTOR_CONFIDENCE.unknown);
  });

  test('un type sans promotion déclarée n\'est jamais promu', async () => {
    const cache = fakeCache([
      entry({ actionName: 'MemberBanAdd', targetId: MEMBRE, channelId: null }),
    ]);

    const verdict = await correlator(cache).resolve(
      event({ type: 'member_ban', channelId: null }),
    );

    assert.equal(verdict.actorId, MODERATEUR, 'attribué, mais pas promu');
    assert.equal(verdict.promotedType, null);
  });

  test('la table ne déclare qu\'une promotion, vers un type existant', () => {
    assert.deepEqual(TYPE_PROMOTIONS, { member_leave: 'member_kick' });

    for (const [source, cible] of Object.entries(TYPE_PROMOTIONS)) {
      assert.ok(LOG_EVENTS.includes(source), source);
      assert.ok(LOG_EVENTS.includes(cible), cible);
    }
  });
});

describe('robustesse', () => {
  test('ne lève jamais, même si le cache lève', async () => {
    const cache = {
      entries: async () => {
        throw new Error('cache cassé');
      },
      isCounted: () => false,
    };

    const logger = fakeLogger();
    const resolveur = createCorrelator({ auditCache: cache, config: config(), logger });

    const verdict = await resolveur.resolve(event());

    assert.deepEqual(verdict, {
      actorId: null,
      actorConfidence: ACTOR_CONFIDENCE.unknown,
      promotedType: null,
    });
    assert.equal(logger.of('warn').length, 1);
    assert.equal(logger.of('error').length, 0, 'un audit indisponible n\'est pas un défaut du bot');
  });

  test('ne modifie pas l\'événement qu\'on lui donne', async () => {
    const donne = event();
    const avant = JSON.stringify(donne);

    await correlator(fakeCache([entry()])).resolve(donne);

    assert.equal(JSON.stringify(donne), avant);
  });

  test('audit_log_entry_id reste null en corrélation directe', async () => {
    // Discord incrémente une entrée existante plutôt que d'en créer une par
    // message supprimé : une même entrée correspond à plusieurs de nos
    // événements, et l'écrire deux fois violerait l'index unique posé au lot 1.
    // Seul le rattrapage du lot 7 renseignera cette colonne.
    const verdict = await correlator(fakeCache([entry({ id: '900000000000000042' })])).resolve(
      event(),
    );

    assert.deepEqual(Object.keys(verdict).sort(), ['actorConfidence', 'actorId', 'promotedType']);
    assert.equal(verdict.auditLogEntryId, undefined, 'la corrélation ne rend pas cet identifiant');
  });
});
