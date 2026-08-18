import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ACTOR_CONFIDENCE,
  EVENT_SOURCE,
  LOG_EVENTS,
  MESSAGE_EVENTS,
} from '../../../src/modules/logs/constants.js';
import { createLogEvent } from '../../../src/modules/logs/event.js';

/**
 * Normalisation d'un événement.
 *
 * Brique pure : aucun import de discord.js, aucune base, aucune configuration.
 * Tout ce qu'elle refuse vient du code, donc elle lève — un repli silencieux
 * transformerait un défaut de programmation en donnée fausse, écrite pour
 * quatre-vingt-dix jours.
 */

const MEMBRE = '123456789012345678';
const MODERATEUR = '987654321098765432';
const SALON = '222222222222222222';

const AT = new Date(Date.UTC(2026, 7, 18, 14, 32, 7, 512));

/** Événement minimal valide, dégradé au cas par cas. */
const input = (patch = {}) => ({
  type: 'member_ban',
  occurredAt: AT,
  actorId: MODERATEUR,
  actorConfidence: ACTOR_CONFIDENCE.certain,
  targetId: MEMBRE,
  channelId: null,
  source: EVENT_SOURCE.live,
  ...patch,
});

/** Message supprimé, seul cas où `content` est admis. */
const message = (patch = {}) =>
  input({
    type: 'message_delete',
    actorId: null,
    actorConfidence: ACTOR_CONFIDENCE.unknown,
    channelId: SALON,
    ...patch,
  });

describe('type d\'événement', () => {
  test('accepte les 33 types déclarés', () => {
    for (const type of LOG_EVENTS) {
      assert.doesNotThrow(
        () => createLogEvent(input({ type })),
        `${type} devrait être accepté`,
      );
    }
  });

  test('lève sur un type inconnu, sans repli ni avertissement', () => {
    // Le type vient du CODE, jamais de la configuration : un type inconnu est un
    // défaut de programmation. Écrire un event_type que rien ne sait relire
    // polluerait la table pour quatre-vingt-dix jours.
    for (const type of ['messsage_delete', 'avatar_change', '', null, undefined, 42]) {
      assert.throws(() => createLogEvent(input({ type })), /type inconnu/, `pour ${type}`);
    }
  });
});

describe('cohérence entre actorId et actorConfidence', () => {
  test('lève quand un auteur manque avec une confiance autre que unknown', () => {
    for (const confidence of [ACTOR_CONFIDENCE.certain, ACTOR_CONFIDENCE.probable]) {
      assert.throws(
        () => createLogEvent(input({ actorId: null, actorConfidence: confidence })),
        /sans actorId/,
        confidence,
      );
    }
  });

  test('lève quand un auteur est fourni avec la confiance unknown', () => {
    // L'affichage lit les deux champs ensemble : « supprimé par X (inconnu) »
    // n'a aucun sens, et rien en aval ne peut rattraper le désaccord.
    assert.throws(
      () =>
        createLogEvent(input({ actorId: MODERATEUR, actorConfidence: ACTOR_CONFIDENCE.unknown })),
      /confiance unknown/,
    );
  });

  test('accepte les trois combinaisons licites', () => {
    assert.doesNotThrow(() =>
      createLogEvent(input({ actorId: null, actorConfidence: ACTOR_CONFIDENCE.unknown })),
    );

    for (const confidence of [ACTOR_CONFIDENCE.certain, ACTOR_CONFIDENCE.probable]) {
      assert.doesNotThrow(() =>
        createLogEvent(input({ actorId: MODERATEUR, actorConfidence: confidence })),
      );
    }
  });

  test('lève sur une confiance hors du jeu déclaré', () => {
    assert.throws(() => createLogEvent(input({ actorConfidence: 'peut_etre' })), /actorConfidence/);
  });
});

describe('source', () => {
  test('accepte live et catchup, refuse le reste', () => {
    for (const source of Object.values(EVENT_SOURCE)) {
      assert.doesNotThrow(() => createLogEvent(input({ source })));
    }

    assert.throws(() => createLogEvent(input({ source: 'replay' })), /source attend/);
  });
});

describe('identifiants Discord', () => {
  test('refuse un identifiant fourni comme nombre', () => {
    // La panne qui a arrêté la version précédente du bot : au-delà de 16
    // chiffres, un nombre est tronqué silencieusement.
    for (const field of ['actorId', 'targetId', 'channelId', 'auditLogEntryId']) {
      assert.throws(
        () => createLogEvent(input({ [field]: 123456789012345678 })),
        /reçu comme nombre/,
        field,
      );
    }
  });

  test('accepte null sur tout ce qui est facultatif', () => {
    const event = createLogEvent(
      input({
        actorId: null,
        actorConfidence: ACTOR_CONFIDENCE.unknown,
        targetId: null,
        channelId: null,
        auditLogEntryId: null,
      }),
    );

    assert.equal(event.actorId, null);
    assert.equal(event.targetId, null);
    assert.equal(event.channelId, null);
    assert.equal(event.auditLogEntryId, null);
  });

  test('un champ omis vaut null, jamais undefined', () => {
    // `undefined` lié par better-sqlite3 lève : la normalisation doit rendre une
    // ligne complète, pas une ligne trouée.
    const event = createLogEvent({
      type: 'guild_update',
      occurredAt: AT,
      actorConfidence: ACTOR_CONFIDENCE.unknown,
      source: EVENT_SOURCE.live,
    });

    for (const field of ['actorId', 'targetId', 'channelId', 'auditLogEntryId', 'content']) {
      assert.equal(event[field], null, field);
    }
  });
});

describe('data ne porte jamais de contenu de message', () => {
  test('lève sur chacune des six clés interdites', () => {
    // Le contenu vit 30 jours dans log_message_content, les métadonnées 90 dans
    // log_events : une copie dans data survivrait à sa propre purge sans que
    // personne ne le remarque.
    for (const key of ['content', 'contentBefore', 'contentAfter', 'message', 'text', 'body']) {
      assert.throws(
        () => createLogEvent(input({ data: { [key]: 'bonjour' } })),
        new RegExp(`data\\.${key}`),
        key,
      );

      // Y compris quand la valeur est vide ou nulle : c'est la CLÉ qui est
      // refusée, pas ce qu'elle porte.
      assert.throws(() => createLogEvent(input({ data: { [key]: null } })), /survivrait/, key);
    }
  });

  test('laisse passer ce qui n\'est pas du contenu', () => {
    const event = createLogEvent(
      input({ data: { before: 'ancien-nom', after: 'nouveau-nom', roles: ['1', '2'] } }),
    );

    assert.deepEqual(JSON.parse(event.data), {
      before: 'ancien-nom',
      after: 'nouveau-nom',
      roles: ['1', '2'],
    });
  });

  test('le contrôle est grossier et ne descend pas dans l\'arbre', () => {
    // Limite assumée et documentée : il ferme le chemin le plus probable, celui
    // qu'on emprunte en recopiant un objet Discord tel quel. Ce n'est pas une
    // garantie.
    assert.doesNotThrow(() => createLogEvent(input({ data: { details: { text: 'passe' } } })));
  });

  test('refuse un data qui n\'est pas un objet', () => {
    for (const value of ['{}', 42, [1, 2]]) {
      assert.throws(() => createLogEvent(input({ data: value })), /data attend un objet/);
    }
  });
});

describe('content', () => {
  test('accepté sur les trois types de message', () => {
    for (const type of MESSAGE_EVENTS) {
      const event = createLogEvent(message({ type, content: { authorId: MEMBRE, before: 'salut' } }));

      assert.equal(event.content.authorId, MEMBRE);
      assert.equal(event.content.before, 'salut');
    }
  });

  test('lève sur tout autre type', () => {
    // Une ligne dans log_message_content rattachée à un événement non-message
    // partirait à 30 jours alors que sa métadonnée en vit 90, et rien ne la
    // relirait entre-temps.
    for (const type of ['member_ban', 'voice_join', 'guild_update']) {
      assert.throws(
        () => createLogEvent(input({ type, content: { authorId: MEMBRE, before: 'x' } })),
        /n'est pas un événement de message/,
        type,
      );
    }
  });

  test('absent ou null rend null, sans erreur', () => {
    assert.equal(createLogEvent(message()).content, null);
    assert.equal(createLogEvent(message({ content: null })).content, null);
    assert.equal(createLogEvent(input({ content: null })).content, null);
  });

  test('les champs manquants deviennent null', () => {
    const { content } = createLogEvent(message({ content: { authorId: MEMBRE } }));

    assert.deepEqual(content, {
      authorId: MEMBRE,
      before: null,
      after: null,
      attachments: null,
    });
  });

  test('attachments est sérialisé, et null reste null', () => {
    const avec = createLogEvent(
      message({ content: { authorId: MEMBRE, attachments: [{ name: 'photo.png', size: 4096 }] } }),
    );

    assert.equal(typeof avec.content.attachments, 'string');
    assert.deepEqual(JSON.parse(avec.content.attachments), [{ name: 'photo.png', size: 4096 }]);

    // Une colonne vide se distingue d'un « aucune pièce jointe » écrit `[]`.
    const sans = createLogEvent(message({ content: { authorId: MEMBRE } }));

    assert.equal(sans.content.attachments, null);
  });

  test('refuse un auteur de message fourni comme nombre', () => {
    assert.throws(
      () => createLogEvent(message({ content: { authorId: 123456789012345678 } })),
      /content\.authorId reçu comme nombre/,
    );
  });
});

describe('sortie prête pour le dépôt', () => {
  test('occurredAt est déjà converti en ISO UTC', () => {
    const event = createLogEvent(input());

    assert.equal(event.occurredAt, '2026-08-18T14:32:07.512Z');
    assert.equal(typeof event.occurredAt, 'string');
  });

  test('lève sur une date invalide plutôt que d\'écrire « Invalid Date »', () => {
    assert.throws(() => createLogEvent(input({ occurredAt: new Date('nawak') })), /Date valide/);
    assert.throws(() => createLogEvent(input({ occurredAt: '2026-08-18' })), /Date valide/);
  });

  test('data est déjà sérialisé, et vaut {} par défaut', () => {
    // Le dépôt lie la valeur telle quelle : deux endroits capables de sérialiser
    // produiraient tôt ou tard deux formes différentes.
    assert.equal(createLogEvent(input()).data, '{}');
    assert.equal(createLogEvent(input({ data: { a: 1 } })).data, '{"a":1}');
  });

  test('rend exactement les clés attendues', () => {
    assert.deepEqual(Object.keys(createLogEvent(input())), [
      'eventType',
      'occurredAt',
      'actorId',
      'actorConfidence',
      'targetId',
      'correlationTargetId',
      'channelId',
      'source',
      'auditLogEntryId',
      'data',
      'content',
    ]);
  });

  test('correlationTargetId est porté mais jamais persisté', () => {
    // `target_id` est déclaré au registre d'effacement comme colonne de MEMBRE :
    // y écrire l'identifiant d'un rôle créé lui donnerait deux sens. Le dépôt
    // énumère ses colonnes, ce champ ne l'atteint jamais.
    const ROLE = '888888888888888888';

    const event = createLogEvent(
      input({ type: 'role_create', targetId: null, correlationTargetId: ROLE, channelId: null }),
    );

    assert.equal(event.correlationTargetId, ROLE);
    assert.equal(event.targetId, null);
  });

  test('correlationTargetId vaut null par défaut, et refuse un nombre', () => {
    assert.equal(createLogEvent(input()).correlationTargetId, null);

    assert.throws(
      () => createLogEvent(input({ correlationTargetId: 123456789012345678 })),
      /correlationTargetId reçu comme nombre/,
    );
  });

  test('renomme type en eventType, comme la colonne', () => {
    assert.equal(createLogEvent(input({ type: 'member_kick' })).eventType, 'member_kick');
  });

  test('refuse une entrée qui n\'est pas un objet', () => {
    for (const value of [null, undefined, 'member_ban', 42]) {
      assert.throws(() => createLogEvent(value), /objet attendu|type inconnu/);
    }
  });
});
