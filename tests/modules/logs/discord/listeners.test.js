import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Events } from 'discord.js';

import { createEmbedEngine } from '../../../../src/core/embeds/index.js';
import { ACTOR_CONFIDENCE } from '../../../../src/modules/logs/constants.js';
import { createDiscordListeners } from '../../../../src/modules/logs/discord/index.js';
import { memberChanges } from '../../../../src/modules/logs/discord/members.js';
import { createLogEvent } from '../../../../src/modules/logs/event.js';
import { createRenderer } from '../../../../src/modules/logs/render.js';
import { logsConfig } from '../config-fixture.js';

/**
 * Écouteurs des familles membres et modération.
 *
 * Ce que ces tests peuvent prouver : qu'un signal de passerelle donné produit
 * les bons événements, ni plus ni moins, et que chacun est normalisable et
 * affichable avec les textes livrés.
 *
 * Ce qu'ils ne peuvent PAS prouver : que Discord envoie bien ce qu'on croit.
 * `guildMemberUpdate` se déclenche pour plusieurs raisons à la fois, et la seule
 * façon de savoir ce qu'il porte vraiment est de regarder le serveur tourner —
 * voir docs/procedures/verification-logs-discord.md.
 */

const MEMBRE = '123456789012345678';
const SALON = '222222222222222222';

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
 * Écouteurs branchés sur un recorder factice qui capture au lieu d'écrire.
 *
 * Le vrai chemin — normalisation, corrélation, exclusions, base — est éprouvé
 * par `wiring.test.js`. Ici, seule compte l'entrée que l'écouteur compose.
 */
const listeners = () => {
  const captures = [];
  const recorder = () => ({
    record: async (input) => {
      captures.push(input);

      return null;
    },
  });

  const list = createDiscordListeners({ recorder });

  return {
    captures,
    list,
    on: (event) => list.find((held) => held.name === event),
    fire: async (event, ...args) => {
      await list.find((held) => held.name === event).execute({}, ...args);

      return captures;
    },
  };
};

/** Membre, tel que discord.js le donne aux écouteurs. */
const member = (patch = {}) => ({
  id: MEMBRE,
  nickname: null,
  communicationDisabledUntilTimestamp: null,
  joinedAt: new Date('2026-01-04T10:00:00.000Z'),
  user: { id: MEMBRE, createdAt: new Date('2025-12-01T09:30:00.000Z') },
  roles: { cache: new Map() },
  ...patch,
});

const withRoles = (ids, patch = {}) =>
  member({ roles: { cache: new Map(ids.map((id) => [id, { id }])) }, ...patch });

const typesOf = (captures) => captures.map((held) => held.type);

describe('déclarations', () => {
  test('chaque nom est une valeur de Events, jamais une clé', () => {
    // `MessageDelete` au lieu de `messageDelete` poserait un écouteur que
    // Discord n'appelle jamais, sans la moindre erreur. Le noyau le refuse au
    // démarrage ; ce test le dit plus tôt.
    const noms = new Set(Object.values(Events));

    for (const listener of listeners().list) {
      assert.ok(noms.has(listener.name), listener.name);
      assert.equal(typeof listener.execute, 'function');
    }
  });

  test('les six écouteurs des deux familles, et rien de plus', () => {
    // Ni messages, ni vocal, ni serveur : ils appartiennent au lot suivant.
    assert.deepEqual(listeners().list.map((held) => held.name), [
      'guildMemberAdd',
      'guildMemberRemove',
      'guildMemberUpdate',
      'guildBanAdd',
      'guildBanRemove',
      'autoModerationActionExecution',
    ]);
  });
});

describe('famille membres', () => {
  test('une arrivée nomme le membre comme acteur, en certain', async () => {
    // On ne rejoint pas un serveur à la place de quelqu'un : la plateforme
    // désigne l'acteur elle-même, aucune corrélation n'intervient.
    const [entree] = await listeners().fire('guildMemberAdd', member());

    assert.equal(entree.type, 'member_join');
    assert.equal(entree.actorId, MEMBRE);
    assert.equal(entree.targetId, MEMBRE);
    assert.equal(entree.actorConfidence, ACTOR_CONFIDENCE.certain);
    assert.equal(entree.data.created_at, '2025-12-01T09:30:00.000Z');
  });

  test('un départ ne fournit AUCUN acteur', async () => {
    // Départ et expulsion sont le même signal : c'est la corrélation qui
    // tranche, et elle promeut en member_kick le cas échéant. Nommer un acteur
    // ici empêcherait la promotion.
    const [entree] = await listeners().fire('guildMemberRemove', member());

    assert.equal(entree.type, 'member_leave');
    assert.equal(entree.actorId, null);
    assert.equal(entree.actorConfidence, ACTOR_CONFIDENCE.unknown);
    assert.equal(entree.data.joined_at, '2026-01-04T10:00:00.000Z');
  });

  test('rien de suivi n\'a changé : aucun événement', async () => {
    // guildMemberUpdate se déclenche aussi pour un avatar, une bannière, un
    // état de vérification — tout ce que le module ne journalise pas.
    const captures = await listeners().fire(
      'guildMemberUpdate',
      member({ avatar: 'avant' }),
      member({ avatar: 'après' }),
    );

    assert.deepEqual(captures, []);
  });

  test('pseudo et rôles changés ensemble émettent plusieurs événements', async () => {
    // Un seul signal de passerelle, trois informations distinctes. Un événement
    // « membre modifié » n'apprendrait rien à personne.
    const captures = await listeners().fire(
      'guildMemberUpdate',
      withRoles(['r1'], { nickname: 'avant' }),
      withRoles(['r1', 'r2'], { nickname: 'après' }),
    );

    assert.deepEqual(typesOf(captures), ['member_nickname', 'member_role_add']);

    const [pseudo, role] = captures;

    assert.equal(pseudo.data.nickname_before, 'avant');
    assert.equal(pseudo.data.nickname_after, 'après');
    assert.equal(role.data.role_id, 'r2');
  });

  test('trois rôles ajoutés émettent trois événements', async () => {
    // La spec distingue attribution et retrait : un événement par rôle, pas un
    // événement portant une liste.
    const captures = await listeners().fire(
      'guildMemberUpdate',
      withRoles([]),
      withRoles(['r1', 'r2', 'r3']),
    );

    assert.deepEqual(typesOf(captures), ['member_role_add', 'member_role_add', 'member_role_add']);
    assert.deepEqual(captures.map((held) => held.data.role_id), ['r1', 'r2', 'r3']);
  });

  test('attribution et retrait simultanés sont deux types distincts', async () => {
    const captures = await listeners().fire(
      'guildMemberUpdate',
      withRoles(['r1', 'r2']),
      withRoles(['r2', 'r3']),
    );

    assert.deepEqual(typesOf(captures), ['member_role_add', 'member_role_remove']);
    assert.equal(captures[0].data.role_id, 'r3');
    assert.equal(captures[1].data.role_id, 'r1');
  });

  test('un pseudo retiré est un changement, pas une absence de changement', async () => {
    const captures = await listeners().fire(
      'guildMemberUpdate',
      member({ nickname: 'Bidule' }),
      member({ nickname: null }),
    );

    assert.deepEqual(typesOf(captures), ['member_nickname']);
    assert.equal(captures[0].data.nickname_after, null);
  });

  test('un timeout posé et un timeout levé se distinguent dans data', async () => {
    // Un seul type pour deux gestes opposés (spec §2) : la distinction ne peut
    // vivre que là.
    const echeance = Date.UTC(2026, 7, 19, 12, 0, 0);

    const [pose] = await listeners().fire(
      'guildMemberUpdate',
      member(),
      member({ communicationDisabledUntilTimestamp: echeance }),
    );

    const [levee] = await listeners().fire(
      'guildMemberUpdate',
      member({ communicationDisabledUntilTimestamp: echeance }),
      member(),
    );

    assert.equal(pose.type, 'member_timeout');
    assert.equal(levee.type, 'member_timeout');
    assert.notEqual(pose.data.variant, levee.data.variant);
    assert.equal(pose.data.until, new Date(echeance).toISOString());
    assert.equal(levee.data.until, undefined);
  });

  test('un état d\'avant absent n\'invente pas d\'attributions de rôles', async () => {
    // Ne se produit pas avec discord.js — il n'émet cet événement que pour un
    // membre déjà en cache — mais l'inverse produirait un événement par rôle du
    // membre, ce qu'un salon de logs n'oublie pas.
    const captures = await listeners().fire('guildMemberUpdate', null, withRoles(['r1', 'r2']));

    assert.deepEqual(captures, []);
  });
});

describe('famille modération', () => {
  const ban = (patch = {}) => ({ user: { id: MEMBRE }, ...patch });

  test('un bannissement ne fournit aucun acteur', async () => {
    // La passerelle ne livre que le membre visé : le modérateur est dans le
    // journal d'audit, et la corrélation l'y trouvera en `probable`.
    const [entree] = await listeners().fire('guildBanAdd', ban());

    assert.equal(entree.type, 'member_ban');
    assert.equal(entree.targetId, MEMBRE);
    assert.equal(entree.actorId, null);
    assert.deepEqual(entree.data, {}, 'aucune raison en direct, donc aucune ligne de détail');
  });

  test('une levée de bannissement est un type distinct', async () => {
    const [entree] = await listeners().fire('guildBanRemove', ban());

    assert.equal(entree.type, 'member_unban');
  });

  test('la raison est reprise quand la structure la porte', async () => {
    const [entree] = await listeners().fire('guildBanAdd', ban({ reason: 'publicité' }));

    assert.equal(entree.data.reason, 'publicité');
  });

  test('AutoMod nomme l\'auteur du message déclencheur, en certain', async () => {
    // L'événement se décrit lui-même : la passerelle livre la règle, l'action
    // et le membre. Il n'y a pas d'auteur humain à chercher.
    const [entree] = await listeners().fire('autoModerationActionExecution', {
      userId: MEMBRE,
      channelId: SALON,
      ruleId: '555555555555555555',
      ruleTriggerType: 1,
      action: { type: 3 },
      matchedKeyword: 'motinterdit',
      matchedContent: 'le message complet du membre',
    });

    assert.equal(entree.type, 'automod_action');
    assert.equal(entree.actorId, MEMBRE);
    assert.equal(entree.actorConfidence, ACTOR_CONFIDENCE.certain);
    assert.equal(entree.channelId, SALON);
    // Des NOMS, jamais les entiers : une renumérotation de la plateforme
    // rendrait fausses toutes les lignes déjà écrites.
    assert.equal(entree.data.trigger, 'Keyword');
    assert.equal(entree.data.action, 'Timeout');
    assert.equal(entree.data.keyword, 'motinterdit');
  });

  test('AutoMod ne recopie JAMAIS le message du membre', async () => {
    // `matchedContent` est du contenu de membre : il relève de
    // log_message_content et de sa rétention de 30 jours. Recopié dans `data`,
    // il survivrait soixante jours à sa propre purge.
    const [entree] = await listeners().fire('autoModerationActionExecution', {
      userId: MEMBRE,
      channelId: SALON,
      ruleId: '555555555555555555',
      ruleTriggerType: 1,
      action: { type: 1 },
      matchedKeyword: 'motinterdit',
      matchedContent: 'le message complet du membre',
    });

    assert.doesNotMatch(JSON.stringify(entree.data), /message complet/);
  });

  test('un type d\'action inconnu de la bibliothèque reste lisible', async () => {
    const [entree] = await listeners().fire('autoModerationActionExecution', {
      userId: MEMBRE,
      channelId: null,
      ruleId: '555555555555555555',
      ruleTriggerType: 99,
      action: { type: 98 },
      matchedKeyword: null,
    });

    assert.equal(entree.data.trigger, '99');
    assert.equal(entree.data.action, '98');
    assert.equal(entree.data.keyword, null);
  });
});

describe('confiance', () => {
  test('AUCUN écouteur ne fournit la confiance probable', async () => {
    // `probable` est le verdict de la corrélation, et d'elle seule. Le
    // fabriquer ici afficherait « (probable) » sur une attribution que rien n'a
    // corrélée — exactement ce que la spec §3 interdit.
    const held = listeners();

    await held.fire('guildMemberAdd', member());
    await held.fire('guildMemberRemove', member());
    await held.fire('guildMemberUpdate', withRoles(['r1'], { nickname: 'a' }), withRoles([]));
    await held.fire('guildBanAdd', { user: { id: MEMBRE } });
    await held.fire('guildBanRemove', { user: { id: MEMBRE } });
    await held.fire('autoModerationActionExecution', {
      userId: MEMBRE,
      channelId: SALON,
      ruleId: '5',
      ruleTriggerType: 1,
      action: { type: 1 },
    });

    assert.ok(held.captures.length > 0, 'le test ne prouverait rien sur une liste vide');

    for (const capture of held.captures) {
      assert.notEqual(capture.actorConfidence, ACTOR_CONFIDENCE.probable, capture.type);
    }
  });
});

describe('rendu de ce que les écouteurs produisent', () => {
  const config = logsConfig();

  /**
   * Tout événement composé par un écouteur doit être normalisable ET affichable
   * avec les textes livrés.
   *
   * C'est ce qui relie les trois fichiers : un `data` rempli sans clé
   * `logs.data.<type>` correspondante dans `messages.yml` afficherait la clé
   * brute dans un salon. Le rendeur le journalise en erreur — ce test le lit.
   */
  const rendu = (input) => {
    const logger = fakeLogger();
    const renderer = createRenderer({
      embeds: createEmbedEngine({ config, logger }),
      config,
      logger,
    });

    const event = createLogEvent(input);

    const { embed } = renderer.renderRich({
      id: 1,
      event,
      routing: {
        channelKey: config.get(`logs.events.${event.eventType}.channel`),
        channelId: SALON,
        deliverable: true,
        reason: null,
      },
    });

    return { embed, logger };
  };

  test('chaque événement des deux familles s\'affiche sans clé ni marqueur perdus', async () => {
    const held = listeners();
    const echeance = Date.UTC(2026, 7, 19, 12, 0, 0);

    await held.fire('guildMemberAdd', member());
    await held.fire('guildMemberRemove', member());
    await held.fire('guildMemberUpdate', member(), member({ nickname: 'Bidule' }));
    await held.fire('guildMemberUpdate', withRoles([]), withRoles(['r1']));
    await held.fire('guildMemberUpdate', withRoles(['r1']), withRoles([]));
    await held.fire('guildMemberUpdate', member(), member({ communicationDisabledUntilTimestamp: echeance }));
    await held.fire('guildMemberUpdate', member({ communicationDisabledUntilTimestamp: echeance }), member());
    await held.fire('guildBanAdd', { user: { id: MEMBRE }, reason: 'publicité' });
    await held.fire('guildBanRemove', { user: { id: MEMBRE } });
    await held.fire('autoModerationActionExecution', {
      userId: MEMBRE,
      channelId: SALON,
      ruleId: '555555555555555555',
      ruleTriggerType: 1,
      action: { type: 1 },
      matchedKeyword: 'motinterdit',
    });

    for (const capture of held.captures) {
      const { embed, logger } = rendu(capture);

      assert.doesNotMatch(embed.description, /\{[a-z][a-z0-9_]*\}/, capture.type);
      assert.doesNotMatch(embed.description, /logs\.data\./, `clé absente pour ${capture.type}`);
      assert.deepEqual(logger.of('error'), [], capture.type);
    }
  });

  test('une expulsion s\'affiche avec le détail d\'un départ', async () => {
    // La promotion de type re-normalise l'entrée du départ : `member_kick` a
    // donc le `data` d'un `member_leave`, et sa propre clé de libellé.
    const [depart] = await listeners().fire('guildMemberRemove', member());

    const { embed, logger } = rendu({ ...depart, type: 'member_kick' });

    assert.doesNotMatch(embed.description, /\{[a-z][a-z0-9_]*\}/);
    assert.deepEqual(logger.of('error'), []);
  });

  test('un événement sans détail n\'affiche pas de ligne vide parasite', async () => {
    // `data` vide vaut « rien à dire » : la ligne disparaît, plutôt que
    // d'afficher un tiret que personne ne saurait interpréter.
    const [ban] = await listeners().fire('guildBanAdd', { user: { id: MEMBRE } });

    const { embed } = rendu(ban);

    assert.doesNotMatch(embed.description, /—\s*$/);
  });

  test('la raison s\'affiche sur un type qui n\'a AUCUN gabarit propre', async () => {
    // Elle vient de la corrélation, pas de l'écouteur, et a donc sa propre
    // ligne. `member_ban` n'a pas de clé `logs.data.member_ban` : l'inscrire
    // dans les gabarits obligerait chaque type, présent et à venir, à la
    // porter.
    const [ban] = await listeners().fire('guildBanAdd', { user: { id: MEMBRE } });

    const { embed, logger } = rendu({ ...ban, data: { reason: 'publicité répétée' } });

    assert.match(embed.description, /publicité répétée/);
    assert.deepEqual(logger.of('error'), [], 'aucune clé de message manquante');
  });

  test('la raison s\'ajoute au détail du type, sans le remplacer', async () => {
    const [role] = await listeners().fire('guildMemberUpdate', withRoles([]), withRoles(['r1']));

    const { embed, logger } = rendu({ ...role, data: { ...role.data, reason: 'promotion' } });

    assert.match(embed.description, /<@&r1>/, 'le détail du type est toujours là');
    assert.match(embed.description, /promotion/);
    assert.deepEqual(logger.of('error'), []);
  });

  test('la raison s\'affiche sur les deux variantes d\'un timeout', async () => {
    // La variante choisit le libellé du type ; la raison est une ligne de plus.
    const echeance = Date.UTC(2026, 7, 19, 12, 0, 0);
    const held = listeners();

    await held.fire('guildMemberUpdate', member(), member({ communicationDisabledUntilTimestamp: echeance }));
    await held.fire('guildMemberUpdate', member({ communicationDisabledUntilTimestamp: echeance }), member());

    for (const capture of held.captures) {
      const { embed, logger } = rendu({ ...capture, data: { ...capture.data, reason: 'insultes' } });

      assert.match(embed.description, /insultes/, capture.data.variant);
      assert.deepEqual(logger.of('error'), [], capture.data.variant);
    }
  });
});

describe('memberChanges, seule', () => {
  test('rend une liste vide plutôt que null', () => {
    // Forme uniforme : l'appelant enchaîne sur `map()` sans distinguer.
    assert.deepEqual(memberChanges(member(), member()), []);
  });

  test('ne modifie ni l\'ancien ni le nouveau membre', () => {
    const avant = withRoles(['r1'], { nickname: 'a' });
    const apres = withRoles(['r2'], { nickname: 'b' });

    memberChanges(avant, apres);

    assert.equal(avant.nickname, 'a');
    assert.deepEqual([...apres.roles.cache.keys()], ['r2']);
  });
});
