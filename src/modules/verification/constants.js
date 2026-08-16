/**
 * Constantes du module.
 *
 * Deux jeux, de natures opposées, et la distinction compte : le premier est
 * PERSISTÉ, le second ne l'est pas. Les traiter avec la même prudence — ou la
 * même légèreté — serait une erreur dans les deux sens.
 *
 * Aucun des deux ne porte de texte destiné à un membre : l'affichage passe par
 * `messages.yml`, comme le reste.
 */

// ---------------------------------------------------------------------------
// Écrit en base — un format, pas un réglage
// ---------------------------------------------------------------------------

/**
 * **Exception assumée à « aucune valeur codée en dur ».** Ces valeurs partent
 * dans `verification_history.event` et sont relues par le code : les rendre
 * configurables permettrait de les renommer, et toutes les lignes déjà écrites
 * deviendraient illisibles au premier renommage. Une valeur persistée n'est pas
 * un réglage, c'est un format.
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

// ---------------------------------------------------------------------------
// Identifiants de composants — persistés dans les messages Discord
// ---------------------------------------------------------------------------

/**
 * Actions routées par l'identifiant de composant, au format
 * `verification:<action>`.
 *
 * Persistés eux aussi, mais dans les messages Discord plutôt qu'en base : un
 * message d'accueil publié il y a six mois porte encore `verification:start`.
 * Les renommer rendrait muet tout bouton déjà publié, jusqu'à ce que le message
 * soit supprimé et republié.
 *
 * Aucune donnée n'y transite : l'auteur de l'interaction est déjà dans l'objet
 * Discord, et le plafond de 100 caractères ne doit pas être entamé pour rien.
 */
export const ACTIONS = Object.freeze({
  /** Bouton du message d'accueil. */
  start: 'start',
  /** Bouton « Entrer le code », dans la réponse éphémère. */
  open: 'open',
  /** Soumission de la modale. */
  submit: 'submit',
});

/**
 * Champ de saisie de la modale.
 *
 * Ce n'est PAS un identifiant de composant routé : il n'est lu que par
 * `fields.getTextInputValue()` à l'intérieur de la modale, et ne passe donc pas
 * par l'encodeur du noyau.
 */
export const CODE_FIELD = 'code';

// ---------------------------------------------------------------------------
// Rendu à l'appelant — un contrat interne, renommable
// ---------------------------------------------------------------------------

/**
 * Ce que le moteur répond, à charge pour l'appelant d'en tirer un message.
 *
 * **Rien de tout ceci n'est écrit en base**, à la différence des événements
 * ci-dessus : c'est un contrat entre le moteur et le code qui l'appelle, et il
 * se renomme donc librement — aucune ligne existante n'en dépend.
 *
 * Le moteur ne rend jamais un booléen : « faux » ne dit pas si le code était
 * mauvais, expiré, ou si le membre était déjà bloqué, et l'appelant n'aurait
 * plus qu'à le redeviner.
 */
export const OUTCOMES = Object.freeze({
  /** Une épreuve est prête. Porte `attachment`, `expiresAt` et `reused`. */
  issued: 'issued',
  /** Code correct. La ligne d'état a été supprimée, l'historique écrit. */
  success: 'success',
  /** Code faux. Porte `remaining`, le nombre de tentatives restantes. */
  wrong: 'wrong',
  /**
   * Code expiré, ou absent de la mémoire après un redémarrage. Les deux sont
   * indistinguables du point de vue du membre et ne coûtent aucune tentative :
   * il n'a pas fauté, son code a simplement cessé d'exister.
   */
  expired: 'expired',
  /** Vérification bloquée. Porte `justBlocked` — voir le moteur. */
  blocked: 'blocked',
  /** Le membre porte déjà le rôle : rien à faire, rien à consommer. */
  already_verified: 'already_verified',

  // Déblocage par le staff. Trois issues et non deux : « rien à faire » dit au
  // modérateur qu'il s'est trompé de personne, là où un « c'est fait »
  // indifférencié le laisserait croire qu'il a réglé un problème qui existe
  // ailleurs.

  /** Le membre était bloqué, il ne l'est plus. */
  unblocked: 'unblocked',
  /** Des tentatives sans blocage : le compteur est reparti de zéro. */
  counter_reset: 'counter_reset',
  /** Aucune ligne : ce membre n'avait ni tentative ni blocage. */
  nothing_to_do: 'nothing_to_do',
});
