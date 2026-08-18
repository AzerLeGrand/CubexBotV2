import {
  ACTOR_CONFIDENCE,
  ACTOR_CONFIDENCE_VALUES,
  EVENT_SOURCE_VALUES,
  LOG_EVENTS,
  MESSAGE_EVENTS,
} from './constants.js';
import { toIsoUtc } from './time.js';

/**
 * Normalisation d'un événement avant écriture.
 *
 * Brique **pure** : ni base, ni configuration, ni logger, ni discord.js. Elle
 * prend ce qu'un futur écouteur aura extrait d'un événement Discord et rend la
 * ligne exacte que le dépôt écrira — ou lève. Rien à convertir en aval.
 *
 * Elle lève plutôt qu'elle ne se rabat : tout ce qu'elle refuse vient du CODE,
 * jamais de la configuration ni d'une saisie. Un repli silencieux transformerait
 * un défaut de programmation en donnée fausse, écrite pour quatre-vingt-dix
 * jours.
 */

/**
 * Sémantique des trois degrés de confiance (spec §3).
 *
 * `certain`  — la plateforme désigne l'auteur directement. Un membre qui
 *              rejoint le serveur, qui se connecte en vocal, qui modifie son
 *              propre message : l'événement porte lui-même son auteur, aucune
 *              déduction n'intervient.
 *
 * `probable` — l'auteur vient d'une CORRÉLATION avec le journal d'audit, sur le
 *              salon, la cible et une fenêtre temporelle. Faillible par
 *              construction : deux actions semblables dans la même seconde et
 *              l'attribution part sur la mauvaise. Le lot 3 produira ces
 *              valeurs ; ce lot ne fait que les admettre.
 *
 * `unknown`  — rien ne désigne d'auteur. Discord n'inscrit RIEN au journal
 *              d'audit quand un membre supprime son propre message : c'est le
 *              cas le plus fréquent, pas une anomalie.
 *
 * L'affichage du lot 4 lit cette colonne pour choisir entre « supprimé par X »,
 * « supprimé par X (probable) » et « auteur inconnu ». Il ne recalcule rien : la
 * fenêtre de corrélation est configurable, et la relire changerait
 * rétroactivement la certitude de lignes déjà écrites.
 */

/**
 * Clés interdites à la racine de `data`.
 *
 * `data` porte ce qui est propre à chaque type d'événement — ancien et nouveau
 * nom d'un salon, rôles ajoutés, règle AutoMod déclenchée. **Jamais du contenu
 * de message.**
 *
 * Le contenu vit 30 jours dans `log_message_content`, les métadonnées 90 jours
 * dans `log_events`. Un contenu recopié dans `data` survivrait donc à sa propre
 * purge de soixante jours, sans que personne ne le remarque : la ligne de
 * contenu partirait à l'heure dite, et sa copie resterait dans une colonne que
 * rien n'inspecte.
 *
 * **Le contrôle est grossier et ne détecte pas tout** — un `data.details.text`
 * passe, un `data.extrait` aussi. Il ferme le chemin le plus probable, celui
 * qu'on emprunte sans y penser en recopiant un objet Discord tel quel. Ce n'est
 * pas une garantie, c'est un garde-fou.
 */
const FORBIDDEN_DATA_KEYS = Object.freeze([
  'content',
  'contentBefore',
  'contentAfter',
  'message',
  'text',
  'body',
]);

const fault = (message) => {
  throw new TypeError(`événement de journalisation invalide : ${message}`);
};

/**
 * Identifiant Discord, ou `null`.
 *
 * Un NOMBRE est refusé explicitement, et c'est le refus le plus important du
 * fichier : au-delà de 16 chiffres, un identifiant lu comme nombre est tronqué
 * silencieusement. C'est la panne qui a arrêté la version précédente du bot, et
 * elle peut revenir par ici — un `data.role_id` recopié d'un JSON mal typé, un
 * identifiant passé par une conversion bien intentionnée.
 */
function optionalId(value, field) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    fault(
      `${field} reçu comme nombre — un identifiant Discord est toujours une chaîne, ` +
        'au-delà de 16 chiffres un nombre est tronqué silencieusement',
    );
  }

  if (typeof value !== 'string' || value.length === 0) {
    fault(`${field} attend un identifiant Discord ou null, reçu ${typeof value}`);
  }

  return value;
}

/** Texte de message, ou `null`. Jamais cité dans une erreur : c'est du contenu. */
function optionalText(value, field) {
  if (value === null || value === undefined) return null;

  if (typeof value !== 'string') fault(`${field} attend une chaîne ou null, reçu ${typeof value}`);

  return value;
}

/**
 * Valide `data` et le sérialise.
 *
 * La sérialisation vit ici et non dans le dépôt : le dépôt reçoit une ligne
 * prête, et deux endroits capables de sérialiser en produiraient tôt ou tard
 * deux formes différentes.
 */
function serializeData(data) {
  if (data === null || data === undefined) return '{}';

  if (typeof data !== 'object' || Array.isArray(data)) {
    fault(`data attend un objet, reçu ${Array.isArray(data) ? 'un tableau' : typeof data}`);
  }

  for (const key of FORBIDDEN_DATA_KEYS) {
    if (Object.hasOwn(data, key)) {
      fault(
        `data.${key} porte du contenu de message — le contenu va dans « content », qui vit ` +
          '30 jours, alors que data en vit 90 : la copie survivrait à sa propre purge',
      );
    }
  }

  return JSON.stringify(data);
}

/**
 * Valide et sérialise le contenu d'un message.
 *
 * `attachments` est sérialisé, `null` restant `null` : une colonne vide se
 * distingue d'un « aucune pièce jointe » écrit `[]`, et évite d'inscrire deux
 * octets sur chaque ligne pour ne rien dire.
 *
 * Les fichiers eux-mêmes ne sont jamais téléchargés (spec §3) : seuls leur nom,
 * leur taille et leur nombre sont conservés.
 */
function normalizeContent(content, type) {
  if (content === null || content === undefined) return null;

  // Le contenu n'a de sens que sur un message. Accepté ailleurs, il écrirait une
  // ligne dans `log_message_content` que la commande de consultation ne
  // regarderait jamais, et que la purge courte ferait disparaître sans que la
  // métadonnée correspondante en sache rien.
  if (!MESSAGE_EVENTS.includes(type)) {
    fault(
      `content fourni sur « ${type} », qui n'est pas un événement de message — ` +
        `attendu l'un de ${MESSAGE_EVENTS.join(', ')}`,
    );
  }

  if (typeof content !== 'object' || Array.isArray(content)) {
    fault(`content attend un objet, reçu ${typeof content}`);
  }

  const { attachments = null } = content;

  return {
    authorId: optionalId(content.authorId, 'content.authorId'),
    before: optionalText(content.before, 'content.before'),
    after: optionalText(content.after, 'content.after'),
    attachments: attachments === null || attachments === undefined
      ? null
      : JSON.stringify(attachments),
  };
}

/**
 * Valide un événement et rend la ligne à écrire.
 *
 * @param {object} input
 * @param {string} input.type              l'un des 33 types de `LOG_EVENTS`
 * @param {Date} input.occurredAt          instant de l'événement, converti ici
 * @param {string|null} [input.actorId]    auteur de l'action
 * @param {string} input.actorConfidence   `certain`, `probable` ou `unknown`
 * @param {string|null} [input.targetId]   membre concerné
 * @param {string|null} [input.correlationTargetId] cible d'audit, non persistée
 * @param {string|null} [input.channelId]  salon OÙ l'action a eu lieu
 * @param {string} input.source            `live` ou `catchup`
 * @param {string|null} [input.auditLogEntryId]
 * @param {object} [input.data]            détail propre au type, sérialisé ici
 * @param {object|null} [input.content]    `{ authorId, before, after, attachments }`
 * @returns {object} prêt pour `repository.insertEvent()`, sans conversion restante
 * @throws {TypeError}
 */
export function createLogEvent(input) {
  if (input === null || typeof input !== 'object') fault(`objet attendu, reçu ${typeof input}`);

  const { type, actorId = null, actorConfidence, source } = input;

  // Un type inconnu est un défaut de programmation, jamais une erreur de
  // configuration : les 33 types viennent du code, et `config.yml` ne peut que
  // les activer ou les désactiver. Aucun repli, aucun avertissement — écrire un
  // `event_type` que rien ne sait relire polluerait la table pour quatre-vingt-dix
  // jours et ferait échouer l'affichage bien plus tard.
  if (!LOG_EVENTS.includes(type)) {
    fault(`type inconnu : ${JSON.stringify(type)} — voir LOG_EVENTS dans constants.js`);
  }

  if (!ACTOR_CONFIDENCE_VALUES.includes(actorConfidence)) {
    fault(
      `actorConfidence attend ${ACTOR_CONFIDENCE_VALUES.join(', ')}, ` +
        `reçu ${JSON.stringify(actorConfidence)}`,
    );
  }

  if (!EVENT_SOURCE_VALUES.includes(source)) {
    fault(`source attend ${EVENT_SOURCE_VALUES.join(' ou ')}, reçu ${JSON.stringify(source)}`);
  }

  const actor = optionalId(actorId, 'actorId');

  // `unknown` si et SEULEMENT si aucun auteur. Les deux incohérences possibles
  // se propageraient jusqu'à l'affichage : un auteur nommé « (inconnu) », ou un
  // « supprimé par (probable) » sans nom derrière. Le lot 4 lit ces deux champs
  // ensemble et n'a aucun moyen de rattraper leur désaccord.
  if (actor === null && actorConfidence !== ACTOR_CONFIDENCE.unknown) {
    fault(
      `actorConfidence vaut ${JSON.stringify(actorConfidence)} sans actorId — ` +
        `sans auteur, la confiance ne peut être que ${ACTOR_CONFIDENCE.unknown}`,
    );
  }

  if (actor !== null && actorConfidence === ACTOR_CONFIDENCE.unknown) {
    fault(
      `actorId est renseigné avec une confiance ${ACTOR_CONFIDENCE.unknown} — ` +
        `un auteur identifié est ${ACTOR_CONFIDENCE.certain} ou ${ACTOR_CONFIDENCE.probable}`,
    );
  }

  return {
    eventType: type,
    occurredAt: toIsoUtc(input.occurredAt),
    actorId: actor,
    actorConfidence,
    targetId: optionalId(input.targetId, 'targetId'),
    /**
     * Cible du journal d'audit, **jamais persistée**.
     *
     * `target_id` est déclaré au registre d'effacement comme colonne de MEMBRE :
     * y écrire l'identifiant d'un rôle créé ou d'un salon supprimé lui donnerait
     * deux sens, et le prochain lecteur de la colonne se tromperait — sans
     * parler d'un effacement RGPD qui anonymiserait un rôle.
     *
     * Le corrélateur compare sur ce champ quand il est fourni, sur `targetId`
     * sinon. L'identité de l'objet d'un événement structurel vit dans `data`,
     * qui est fait pour ça. Le dépôt énumère ses colonnes : ce champ ne
     * l'atteint jamais.
     */
    correlationTargetId: optionalId(input.correlationTargetId, 'correlationTargetId'),
    channelId: optionalId(input.channelId, 'channelId'),
    source,
    auditLogEntryId: optionalId(input.auditLogEntryId, 'auditLogEntryId'),
    data: serializeData(input.data),
    content: normalizeContent(input.content, type),
  };
}
