/**
 * Constantes du module de journalisation.
 *
 * **Exception assumée à « aucune valeur codée en dur »**, la même que celle de
 * `verification/constants.js` : ces valeurs sont ÉCRITES EN BASE et relues par
 * le code. Les rendre configurables permettrait de les renommer, et toutes les
 * lignes déjà écrites deviendraient illisibles au premier renommage. Une valeur
 * persistée n'est pas un réglage, c'est un format.
 *
 * Ce qui EST configurable vit dans `config.yml` : quels événements sont actifs,
 * vers quel salon chacun part, et les identifiants de ces salons.
 *
 * Aucun texte destiné à un membre ici : l'affichage passera par `messages.yml`
 * et `embeds.yml` aux lots suivants.
 *
 * Ce fichier est importé par `manifest.js`, donc lu à l'étape 0 du démarrage,
 * avant les secrets et avant la configuration. Il ne doit rien faire d'autre que
 * déclarer — aucun effet de bord, aucun import.
 */

// ---------------------------------------------------------------------------
// Salons de restitution
// ---------------------------------------------------------------------------

/**
 * Clés de `logs.channels`, et donc les seules valeurs admises pour le champ
 * `channel` d'un événement.
 *
 * Le jeu est fermé : ces clés servent à la fois de sous-section de `config.yml`
 * et de cible de la validation croisée du fragment. Ajouter un salon impose donc
 * d'ajouter sa clé ici, ce qui est exactement le point de contrôle voulu — une
 * clé inventée dans le YAML n'a nulle part où se raccrocher.
 */
export const LOG_CHANNELS = Object.freeze([
  'messages',
  'voice',
  'members',
  'server',
  'moderation',
]);

// ---------------------------------------------------------------------------
// Types d'événement — écrits dans log_events.event_type
// ---------------------------------------------------------------------------

/**
 * Événements journalisés (spec §2).
 *
 * Trois décisions inscrites dans cette liste, qui la font diverger de la lecture
 * naïve de la spec :
 *
 * - **Aucun changement d'avatar.** Non retenu.
 * - **`member_timeout` n'apparaît qu'une fois**, côté modération. La spec le
 *   listait aussi sous « Membres » : c'est un doublon, pas deux événements.
 * - **Un seul `webhook_update`.** Discord n'émet ni création ni suppression
 *   distinctes de webhook, seulement une mise à jour du salon concerné.
 *
 * Le regroupement par salon ci-dessous n'est qu'une valeur par défaut, écrite
 * dans `config.yml` : chaque événement pointe individuellement vers son salon et
 * peut en changer sans toucher au code.
 */
export const LOG_EVENTS = Object.freeze([
  // Messages
  'message_delete',
  'message_edit',
  'message_bulk_delete',

  // Vocal
  'voice_join',
  'voice_leave',
  'voice_move',
  'voice_server_mute',
  'voice_server_deafen',
  'voice_suppress',

  // Membres
  'member_join',
  'member_leave',
  'member_nickname',
  'member_role_add',
  'member_role_remove',

  // Serveur
  'role_create',
  'role_delete',
  'role_update',
  'channel_create',
  'channel_delete',
  'channel_update',
  'channel_permissions_update',
  'webhook_update',
  'emoji_create',
  'emoji_delete',
  'emoji_update',
  'invite_create',
  'invite_delete',
  'guild_update',

  // Modération
  'member_ban',
  'member_unban',
  'member_kick',
  'member_timeout',
  'automod_action',
]);

// ---------------------------------------------------------------------------
// Certitude de l'attribution — écrite dans log_events.actor_confidence
// ---------------------------------------------------------------------------

/**
 * Degré de confiance dans l'identification de l'auteur d'une action (spec §3).
 *
 * Le journal d'audit Discord ne fournit AUCUN lien direct entre une entrée et un
 * message précis : la corrélation se fait sur le salon, la cible et une fenêtre
 * temporelle, et elle est faillible dès que deux actions semblables tombent dans
 * la même seconde. Cette colonne porte cette incertitude jusqu'à l'affichage,
 * qui doit dire « supprimé par X (probable) » plutôt que d'affirmer.
 *
 * La stocker plutôt que la recalculer à l'affichage est délibéré : la fenêtre de
 * corrélation est configurable, et un affichage qui la relirait changerait
 * rétroactivement la certitude d'événements déjà écrits.
 */
export const ACTOR_CONFIDENCE = Object.freeze({
  /** L'événement porte lui-même son auteur — aucune corrélation en jeu. */
  certain: 'certain',
  /** Une entrée d'audit correspond dans la fenêtre, sans garantie. */
  probable: 'probable',
  /** Rien dans le journal d'audit : l'auteur reste inconnu, et se dit tel. */
  unknown: 'unknown',
});

/** Jeu des valeurs admises, repris tel quel par la contrainte CHECK. */
export const ACTOR_CONFIDENCE_VALUES = Object.freeze(Object.values(ACTOR_CONFIDENCE));

// ---------------------------------------------------------------------------
// Provenance — écrite dans log_events.source
// ---------------------------------------------------------------------------

/**
 * Comment l'événement est arrivé jusqu'à nous (spec §8).
 *
 * Le rattrapage après coupure relit le journal d'audit et enregistre ce qui a
 * été manqué. La spec exige que ces événements soient signalés comme tels dans
 * les salons Discord : sans la mention, des événements datés de la veille
 * apparaîtraient sans explication.
 */
export const EVENT_SOURCE = Object.freeze({
  /** Reçu en direct par la passerelle. */
  live: 'live',
  /** Reconstitué depuis le journal d'audit après un arrêt du bot. */
  catchup: 'catchup',
});

/** Jeu des valeurs admises, repris tel quel par la contrainte CHECK. */
export const EVENT_SOURCE_VALUES = Object.freeze(Object.values(EVENT_SOURCE));
