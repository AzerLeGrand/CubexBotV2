import { ACTOR_CONFIDENCE, EVENT_SOURCE } from '../constants.js';
import { createEmitter } from './emit.js';

/**
 * Écouteurs de la famille « membres » (spec §2).
 *
 * Arrivée, départ, pseudo, rôles, exclusion temporaire. Ils traduisent un signal
 * de passerelle en entrée de `record()` et **ne décident de rien d'autre** :
 * l'activation, la corrélation, les exclusions et l'aiguillage vivent en amont
 * du module et ne se rejouent pas ici.
 *
 * **Aucun écouteur ne produit `probable`.** Cette confiance est le verdict de la
 * corrélation avec le journal d'audit, et elle seule sait le rendre. Un écouteur
 * ne connaît que deux situations : la plateforme désigne l'acteur — `certain` —
 * ou elle n'en désigne aucun — `unknown`, à charge pour la corrélation de faire
 * mieux. Fabriquer un `probable` ici afficherait « (probable) » sur une
 * attribution que rien n'a corrélée.
 *
 * **Le changement d'avatar est écarté** (spec §2) : il ne dit rien à la
 * modération, et un membre qui change d'image trois fois dans l'après-midi noie
 * le salon. `guildMemberUpdate` le porte pourtant — ne pas l'ajouter.
 */

/** Date valide, ou l'instant présent. Un `Invalid Date` ferait lever `toIsoUtc()`. */
const at = (value) => (value instanceof Date && !Number.isNaN(value.getTime()) ? value : new Date());

/** Date stockable dans `data`, ou `null`. Le rendu la met au fuseau du lecteur. */
const iso = (value) =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : null;

/**
 * Rôles d'un membre, sous forme d'identifiants.
 *
 * `roles.cache` est une Collection, donc une Map : ses clés SONT les
 * identifiants. Les lire ainsi évite de dépendre de la forme des objets de rôle,
 * qui n'apporteraient rien de plus ici.
 */
const roleIdsOf = (member) => [...(member?.roles?.cache?.keys() ?? [])];

/**
 * Ce qui a changé entre deux états d'un membre, en autant d'événements.
 *
 * **`guildMemberUpdate` se déclenche pour plusieurs raisons à la fois.** Un
 * modérateur qui renomme un membre et lui attribue deux rôles d'un même geste
 * produit UN signal de passerelle et doit produire TROIS événements : la spec
 * distingue l'attribution du retrait, et un salon qui dirait « membre modifié »
 * n'apprendrait rien à personne.
 *
 * Rien de suivi n'a changé — un avatar, une bannière, un état de vérification —
 * rend une liste vide, et aucun événement n'est enregistré.
 *
 * Fonction PURE, exportée pour être éprouvée seule : c'est la pièce où une
 * comparaison manquée se paierait en événements fantômes.
 *
 * @param {object} oldMember état avant
 * @param {object} newMember état après
 * @returns {object[]} entrées prêtes pour `record()`
 */
export function memberChanges(oldMember, newMember) {
  const changes = [];

  // Une base commune : tous ces événements visent le même membre, aucun ne se
  // rattache à un salon, et aucun ne porte d'acteur — le journal d'audit dira
  // qui a agi, ou personne ne le dira.
  const base = {
    occurredAt: new Date(),
    actorId: null,
    actorConfidence: ACTOR_CONFIDENCE.unknown,
    targetId: newMember.id,
    channelId: null,
    source: EVENT_SOURCE.live,
  };

  // 1. Pseudo. `null` et absence sont le même état — « pas de pseudo » — et les
  //    distinguer produirait un événement sur un membre qui n'a rien fait.
  const before = oldMember.nickname ?? null;
  const after = newMember.nickname ?? null;

  if (before !== after) {
    changes.push({
      ...base,
      type: 'member_nickname',
      data: { nickname_before: before, nickname_after: after },
    });
  }

  // 2. Rôles. UN ÉVÉNEMENT PAR RÔLE, et deux types distincts : attribuer et
  //    retirer ne portent pas la même information pour la modération, et un
  //    événement unique portant deux listes serait illisible dans un salon.
  const held = new Set(roleIdsOf(oldMember));
  const kept = new Set(roleIdsOf(newMember));

  for (const roleId of kept) {
    if (!held.has(roleId)) {
      changes.push({ ...base, type: 'member_role_add', data: { role_id: roleId } });
    }
  }

  for (const roleId of held) {
    if (!kept.has(roleId)) {
      changes.push({ ...base, type: 'member_role_remove', data: { role_id: roleId } });
    }
  }

  // 3. Exclusion temporaire, POSÉE OU LEVÉE sous le même type (spec §2). La
  //    distinction va dans `data` : deux types auraient dupliqué l'entrée de
  //    configuration, le libellé et l'aiguillage pour un seul geste de
  //    modération, qui s'annule lui-même.
  //
  //    L'expiration naturelle n'émet RIEN — Discord ne signale que ce qu'un
  //    modérateur fait. Un `member_timeout` levé est donc toujours une levée
  //    volontaire, jamais la fin du délai.
  const wasUntil = oldMember.communicationDisabledUntilTimestamp ?? null;
  const isUntil = newMember.communicationDisabledUntilTimestamp ?? null;

  if (wasUntil !== isUntil) {
    changes.push({
      ...base,
      type: 'member_timeout',
      data:
        isUntil === null ? { variant: 'lifted' } : { variant: 'set', until: iso(new Date(isUntil)) },
    });
  }

  return changes;
}

export function createMemberListeners({ recorder }) {
  const { emit, emitAll } = createEmitter({ recorder });

  return [
    {
      /**
       * Arrivée sur le serveur.
       *
       * Acteur et cible sont le même membre, et la confiance est `certain` : on
       * ne rejoint pas un serveur à la place de quelqu'un. Aucune action d'audit
       * n'est interrogée pour ce type — la corrélation garde donc ce verdict.
       *
       * `data.created_at` porte la date de création du COMPTE, pas celle de
       * l'arrivée : un compte créé le matin même qui rejoint l'après-midi est le
       * signal que ce salon existe pour donner.
       */
      name: 'guildMemberAdd',
      execute: (ctx, member) =>
        emit({
          type: 'member_join',
          occurredAt: at(member.joinedAt),
          actorId: member.id,
          actorConfidence: ACTOR_CONFIDENCE.certain,
          targetId: member.id,
          channelId: null,
          source: EVENT_SOURCE.live,
          data: { created_at: iso(member.user?.createdAt) },
        }),
    },
    {
      /**
       * Départ du serveur — ou expulsion, on ne le sait pas encore.
       *
       * **Discord n'émet qu'un seul signal pour les deux.** Aucun acteur n'est
       * fourni, délibérément : trouver une entrée `MemberKick` récente PROMEUT
       * l'événement en `member_kick`, qui part vers le salon de modération et
       * alimentera le casier de la phase 3. C'est la corrélation qui tranche,
       * jamais l'écouteur — il n'a pas accès au journal d'audit.
       *
       * `data.joined_at` dit depuis quand le membre était là. Il vient du cache
       * et peut manquer sur un membre que le bot n'a jamais vu.
       */
      name: 'guildMemberRemove',
      execute: (ctx, member) =>
        emit({
          type: 'member_leave',
          occurredAt: new Date(),
          actorId: null,
          actorConfidence: ACTOR_CONFIDENCE.unknown,
          targetId: member.id,
          channelId: null,
          source: EVENT_SOURCE.live,
          data: { joined_at: iso(member.joinedAt) },
        }),
    },
    {
      /**
       * Pseudo, rôles, exclusion temporaire — plusieurs à la fois.
       *
       * discord.js n'émet cet événement que pour un membre DÉJÀ EN CACHE ; sinon
       * il émet `guildMemberAvailable`. L'état d'avant est donc toujours un état
       * réel, jamais une reconstitution partielle qui ferait passer tous les
       * rôles du membre pour des attributions.
       */
      name: 'guildMemberUpdate',
      execute: (ctx, oldMember, newMember) => {
        if (oldMember === null || oldMember === undefined) return Promise.resolve([]);

        return emitAll(memberChanges(oldMember, newMember));
      },
    },
  ];
}
