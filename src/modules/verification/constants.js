/**
 * Constantes du module écrites en base.
 *
 * **Exception assumée à « aucune valeur codée en dur ».** Ces valeurs partent
 * dans `verification_history.event` et sont relues par le code : les rendre
 * configurables permettrait de les renommer, et toutes les lignes déjà écrites
 * deviendraient illisibles au premier renommage. Une valeur persistée n'est pas
 * un réglage, c'est un format.
 *
 * Elles ne portent aucun texte destiné à un membre : l'affichage d'un événement
 * passera par `messages.yml`, comme le reste.
 */

/** Événements consignés dans `verification_history` (spec section 7). */
export const HISTORY_EVENTS = Object.freeze({
  /** Code correct, rôle attribué. */
  success: 'success',
  /** Code faux. L'expiration n'en est pas un : elle ne consomme pas de tentative. */
  failure: 'failure',
  /** Tentatives épuisées, blocage posé. */
  block: 'block',
  /** Blocage levé par un membre du staff, seul cas où `actor_id` est renseigné. */
  unblock: 'unblock',
});

/** Jeu des valeurs admises, pour contrôler ce qui est écrit. */
export const HISTORY_EVENT_VALUES = Object.freeze(Object.values(HISTORY_EVENTS));
