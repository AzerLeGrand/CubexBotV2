import { PUBLIC } from '../config/schema/primitives.js';

/**
 * Permissions par liste de rôles (socle §8.2).
 *
 * Le système natif de Discord n'est pas utilisé : il se règle depuis l'interface
 * du serveur, hors du dépôt, et personne ne saurait dire qui a changé quoi.
 */

/**
 * Le demandeur a-t-il le droit d'exécuter cette commande ?
 *
 * Fonction pure, sans discord.js : c'est la décision qui compte, pas la forme
 * de l'objet qui la porte.
 *
 * @param {string[] | 'public' | undefined} allowedRoles issu de `config.yml`
 * @param {Iterable<string>} memberRoleIds rôles du demandeur
 * @returns {boolean}
 */
export function isAllowed(allowedRoles, memberRoleIds) {
  if (allowedRoles === PUBLIC) return true;

  // Une commande sans configuration est refusée, jamais ouverte : une entrée
  // oubliée doit se remarquer par un refus, pas par un /ban accessible à tous.
  if (!Array.isArray(allowedRoles) || allowedRoles.length === 0) return false;

  const held = new Set(memberRoleIds ?? []);

  return allowedRoles.some((roleId) => held.has(roleId));
}

/**
 * Extrait les identifiants de rôle d'une interaction.
 *
 * discord.js expose `member.roles` en collection sur un serveur, mais en simple
 * tableau quand le membre vient d'un événement brut. Les deux formes sont
 * acceptées pour que le routage n'ait pas à s'en soucier — et pour que les
 * tests n'aient pas à construire une Collection.
 */
export function roleIdsOf(member) {
  const roles = member?.roles;

  if (roles === undefined || roles === null) return [];
  if (Array.isArray(roles)) return roles;
  if (roles.cache !== undefined) return [...roles.cache.keys()];

  return [];
}
