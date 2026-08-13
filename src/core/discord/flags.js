/**
 * Drapeaux de message de la plateforme Discord.
 *
 * Partagés par les registres du noyau plutôt que recopiés dans chacun. Discord
 * a déjà déplacé cette valeur une fois — `ephemeral: true` déprécié au profit
 * de `flags: MessageFlags.Ephemeral` — et deux copies, c'est une chance sur
 * deux d'en oublier une le jour où elle rebouge. L'oubli ne se verrait pas à la
 * relecture : il se manifesterait par un refus de permission publié en clair
 * dans le salon, visible de tous.
 *
 * Valeur littérale, et non `MessageFlags.Ephemeral` lu depuis discord.js : une
 * clé renommée rendrait `undefined`, que l'API accepte en publiant le message à
 * tout le monde. C'est exactement le risque qu'on cherche à couvrir, en pire —
 * silencieux. À vérifier sur la documentation à chaque montée majeure, comme
 * les limites d'embed.
 */

/** Répondre au seul demandeur. Valeur de `MessageFlags.Ephemeral`. */
export const EPHEMERAL = 64;
