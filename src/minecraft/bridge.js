/**
 * Interface du pont vers le serveur Minecraft.
 *
 * **Le pont est reporté hors v1** (socle §11). Ce fichier ne décrit que la
 * forme attendue : il réserve l'emplacement pour éviter une réécriture le jour
 * où le pont sera écrit, et donne aux commandes une cible stable à appeler dès
 * maintenant.
 *
 * Ne pas implémenter le pont sans instruction explicite. Le contexte technique
 * — LuckPerms en MariaDB, justCombat à migrer, transport TLS entre OVH et
 * IONOS — est consigné au §11 du socle.
 *
 * @typedef {object} MinecraftBridge
 *
 * @property {() => boolean} isEnabled
 *   Le pont est-il actif ? Toujours `false` tant que `minecraft.enabled` l'est.
 *
 * @property {(uuid: string) => Promise<string>} getRank
 *   Grade LuckPerms d'un joueur. Se lit dans `luckperms_user_permissions` via
 *   les nœuds `group.<nom>` — la colonne `primary_group` de `luckperms_players`
 *   n'est pas fiable.
 *
 * @property {(uuid: string) => Promise<CombatStats>} getCombatStats
 *   Statistiques justCombat : kills, morts, dégâts infligés et subis, streak
 *   courant et meilleur streak.
 *
 * @property {(discordId: string, username: string) => Promise<AccountLink>} linkAccount
 *   Lie un compte Discord à un compte Minecraft.
 *
 * @property {(discordId: string) => Promise<AccountLink | null>} getLink
 *   Liaison existante pour un identifiant Discord, `null` s'il n'y en a pas.
 *
 * @property {(discordId: string) => Promise<void>} unlinkAccount
 *   Rompt la liaison. Nécessaire au droit à l'effacement du §10.
 *
 * @typedef {object} CombatStats
 * @property {number} kills
 * @property {number} deaths
 * @property {number} damageDealt
 * @property {number} damageTaken
 * @property {number} currentStreak
 * @property {number} bestStreak
 *
 * @typedef {object} AccountLink
 * @property {string} discordId
 * @property {string} uuid
 * @property {string} username
 * @property {string} linkedAt horodatage ISO 8601
 */

/** Méthodes que toute implémentation du pont doit fournir. */
export const BRIDGE_METHODS = Object.freeze([
  'getRank',
  'getCombatStats',
  'linkAccount',
  'getLink',
  'unlinkAccount',
]);
