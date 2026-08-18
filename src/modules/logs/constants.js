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

/**
 * Nom du module, donc de sa section dans `config.yml` et de son propriétaire de
 * migrations. Le chargeur du noyau exige qu'il vaille le nom du dossier.
 */
export const MODULE_NAME = 'logs';

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

/**
 * Identifiant de la capacité qui porte un salon de restitution.
 *
 * Fabriqué plutôt qu'écrit deux fois : la déclaration d'`index.js` et la lecture
 * du routeur doivent désigner exactement la même capacité. Deux littéraux
 * finiraient par diverger à un renommage, et le routeur interrogerait alors une
 * capacité jamais déclarée — que le registre considère active par défaut. Le
 * symptôme serait un `deliverable: true` sur un salon supprimé.
 */
export const logChannelCapability = (key) => `${MODULE_NAME}.channel.${key}`;

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

/**
 * Les seuls types qui peuvent porter un contenu de message.
 *
 * Sous-ensemble de `LOG_EVENTS`, et non une liste indépendante : c'est le
 * critère qui décide si une ligne part dans `log_message_content`. Un contenu
 * accepté sur `member_ban` écrirait une ligne que rien ne relit, sous une
 * rétention de 30 jours, rattachée à une métadonnée qui en vit 90.
 */
export const MESSAGE_EVENTS = Object.freeze([
  'message_delete',
  'message_edit',
  'message_bulk_delete',
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

// ---------------------------------------------------------------------------
// Correspondance vers le journal d'audit
// ---------------------------------------------------------------------------

/**
 * Actions du journal d'audit à interroger pour attribuer un auteur, par type
 * d'événement.
 *
 * **Toujours une LISTE**, y compris quand elle ne contient qu'un nom, et vide
 * plutôt qu'absente quand aucune action n'existe. Une forme uniforme évite qu'un
 * appelant traite un cas et pas l'autre — le `null` de la première version
 * demandait deux chemins de code là où il n'y a qu'une seule question.
 *
 * **Des NOMS, jamais des nombres.** Même règle que les intents : le nom est
 * résolu au câblage contre `AuditLogEvent` de discord.js, et un nom inconnu lève
 * au démarrage. Un entier écrit en dur ici deviendrait faux en silence à la
 * première renumérotation de la plateforme, et l'erreur serait une attribution
 * fausse — invisible, puisqu'elle s'affiche exactement comme une bonne.
 *
 * Ce fichier étant lu à l'étape 0 par le manifeste, il n'importe pas
 * discord.js : la vérification vit dans `audit.js` et reçoit l'énumération.
 *
 * Quatre familles de liste vide, pour quatre raisons distinctes :
 *
 * - **Aucune action n'existe.** `message_edit` : seul l'auteur peut modifier son
 *   message, Discord n'inscrit rien. L'acteur est connu sans requête, et la
 *   confiance est `certain`.
 * - **L'acte est volontaire.** `member_join`, `voice_join` : le sujet est
 *   l'acteur, il n'y a rien à attribuer.
 * - **L'entrée existe mais ne porte pas de cible.** `voice_leave` et
 *   `voice_move` correspondent à `MemberDisconnect` et `MemberMove`, dont les
 *   entrées ne portent QU'un salon et un compteur — aucun identifiant de membre.
 *   Le critère de cible ne pourrait jamais être satisfait : la requête serait
 *   dépensée pour rendre `unknown` à tous les coups.
 * - **L'événement se décrit lui-même.** `automod_action` : la passerelle livre
 *   la règle, l'action et le membre. Il n'y a pas d'auteur humain à trouver.
 */
export const AUDIT_ACTIONS = Object.freeze({
  // -- Messages --------------------------------------------------------------
  // Discord n'inscrit RIEN quand un membre supprime son propre message :
  // l'absence d'entrée ne signifie pas l'absence d'auteur, elle signifie
  // `unknown`. C'est le cas le plus fréquent, pas une anomalie.
  message_delete: Object.freeze(['MessageDelete']),
  message_edit: Object.freeze([]),
  message_bulk_delete: Object.freeze(['MessageBulkDelete']),

  // -- Vocal -----------------------------------------------------------------
  voice_join: Object.freeze([]),
  voice_leave: Object.freeze([]),
  voice_move: Object.freeze([]),
  // Les trois coupures imposées par le serveur passent toutes par MemberUpdate,
  // qui ne les distingue que par le champ modifié. La corrélation ne lit pas ce
  // champ : un membre rendu muet et sourd dans la même seconde produit deux
  // candidates, donc `unknown`. Direction sûre, et assumée.
  voice_server_mute: Object.freeze(['MemberUpdate']),
  voice_server_deafen: Object.freeze(['MemberUpdate']),
  voice_suppress: Object.freeze(['MemberUpdate']),

  // -- Membres ---------------------------------------------------------------
  member_join: Object.freeze([]),
  // Départ et expulsion sont le MÊME signal de passerelle : seule une entrée
  // d'audit récente les sépare. Trouver une candidate ici PROMEUT l'événement en
  // `member_kick` — voir `TYPE_PROMOTIONS`. Sans candidate, c'est un départ
  // volontaire.
  member_leave: Object.freeze(['MemberKick']),
  member_nickname: Object.freeze(['MemberUpdate']),
  member_role_add: Object.freeze(['MemberRoleUpdate']),
  member_role_remove: Object.freeze(['MemberRoleUpdate']),

  // -- Serveur ---------------------------------------------------------------
  role_create: Object.freeze(['RoleCreate']),
  role_delete: Object.freeze(['RoleDelete']),
  role_update: Object.freeze(['RoleUpdate']),
  channel_create: Object.freeze(['ChannelCreate']),
  channel_delete: Object.freeze(['ChannelDelete']),
  channel_update: Object.freeze(['ChannelUpdate']),
  // Les TROIS actions, pas seulement la modification : ajouter et retirer une
  // permission sont les deux gestes les plus courants, et n'interroger que
  // `ChannelOverwriteUpdate` les rendrait tous deux `unknown`.
  channel_permissions_update: Object.freeze([
    'ChannelOverwriteCreate',
    'ChannelOverwriteUpdate',
    'ChannelOverwriteDelete',
  ]),
  // Discord n'émet QU'UN SEUL événement de passerelle pour les webhooks, sans
  // dire lequel a changé ni dans quel sens. Le journal d'audit est le seul moyen
  // de savoir ce qui s'est passé : n'interroger que `WebhookUpdate` perdrait à
  // la fois l'auteur et la nature de l'action.
  webhook_update: Object.freeze(['WebhookCreate', 'WebhookUpdate', 'WebhookDelete']),
  emoji_create: Object.freeze(['EmojiCreate']),
  emoji_delete: Object.freeze(['EmojiDelete']),
  emoji_update: Object.freeze(['EmojiUpdate']),
  invite_create: Object.freeze(['InviteCreate']),
  invite_delete: Object.freeze(['InviteDelete']),
  guild_update: Object.freeze(['GuildUpdate']),

  // -- Modération ------------------------------------------------------------
  member_ban: Object.freeze(['MemberBanAdd']),
  member_unban: Object.freeze(['MemberBanRemove']),
  member_kick: Object.freeze(['MemberKick']),
  // Partagée avec member_nickname : Discord range les deux sous MemberUpdate.
  member_timeout: Object.freeze(['MemberUpdate']),
  automod_action: Object.freeze([]),
});

/** Noms distincts à résoudre au câblage. Sert au contrôle de démarrage. */
export const AUDIT_ACTION_NAMES = Object.freeze([
  ...new Set(Object.values(AUDIT_ACTIONS).flat()),
]);

/**
 * Actions dont une seule entrée couvre PLUSIEURS actes.
 *
 * Discord ne crée pas une entrée par message supprimé : quand un même
 * modérateur supprime plusieurs messages du même auteur dans le même salon, il
 * incrémente le compteur d'une entrée existante. Sur ces actions, la seule façon
 * de savoir qu'une entrée correspond à un NOUVEL acte est de comparer son
 * compteur à celui vu au rafraîchissement précédent.
 */
export const COUNTED_AUDIT_ACTIONS = Object.freeze(['MessageDelete', 'MessageBulkDelete']);

// ---------------------------------------------------------------------------
// Promotions de type
// ---------------------------------------------------------------------------

/**
 * Types dont la corrélation peut changer la nature, et vers quoi.
 *
 * `member_leave` et `member_kick` sont le MÊME signal de passerelle : Discord
 * annonce qu'un membre n'est plus là, sans dire s'il est parti ou s'il a été
 * expulsé. Seule une entrée d'audit récente les sépare, et l'écouteur ne peut
 * pas trancher lui-même — il n'a pas accès au journal d'audit avant la file
 * d'attente.
 *
 * La distinction n'est donc PAS cosmétique : les deux types ne partent pas dans
 * le même salon — `members` pour l'un, `moderation` pour l'autre — et
 * l'expulsion alimentera le casier de la phase 3. Résoudre le salon sur le type
 * d'origine enverrait toutes les expulsions dans le salon des arrivées.
 *
 * **Table fermée, et le recorder la fait respecter.** Une promotion vers un type
 * absent d'ici lève : sans ce garde-fou, un défaut du corrélateur pourrait
 * réécrire n'importe quel événement en n'importe quoi.
 *
 * **Une promotion exige une candidate UNIQUE.** Plusieurs candidates rendent
 * `unknown` et ne promeuvent rien : un départ mal attribué en expulsion irait
 * dans le salon de modération et alimenterait un casier à tort.
 */
export const TYPE_PROMOTIONS = Object.freeze({
  member_leave: 'member_kick',
});
 