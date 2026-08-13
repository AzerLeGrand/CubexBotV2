/**
 * Types d'erreur du projet.
 *
 * À ne pas confondre avec `src/core/config/errors.js`, qui décrit des anomalies
 * de configuration : celles-là ne sont pas des exceptions, elles s'accumulent
 * et s'affichent ensemble. Ici, ce sont bien des erreurs jetées à l'exécution.
 */

/**
 * Erreur du bot.
 *
 * Deux messages, jamais confondus : `message` est technique et part au journal ;
 * `template` désigne un gabarit d'`embeds.yml` pour ce que verra l'utilisateur.
 * Aucun texte destiné à quelqu'un ne transite par une exception.
 *
 * `expected` sépare ce qui était prévu — un refus de permission, une
 * fonctionnalité désactivée — de ce qui ne l'était pas. Une erreur inattendue
 * signale un défaut du code, et se traite autrement qu'un refus.
 */
export class AppError extends Error {
  /**
   * @param {string} message message technique, destiné au journal
   * @param {object} [options]
   * @param {string} [options.code]      identifiant stable, filtrable dans les journaux
   * @param {string} [options.template]  gabarit d'embeds.yml pour la réponse à l'utilisateur
   * @param {object} [options.variables] variables du gabarit
   * @param {object} [options.context]   contexte structuré pour le journal
   * @param {unknown} [options.cause]    erreur d'origine
   * @param {boolean} [options.expected] opérationnelle (défaut) ou défaut du code
   */
  constructor(message, options = {}) {
    const { code = 'app_error', template = null, variables = {}, context = {}, cause, expected = true } =
      options;

    super(message, cause === undefined ? undefined : { cause });

    this.name = new.target.name;
    this.code = code;
    this.template = template;
    this.variables = variables;
    this.context = context;
    this.expected = expected;

    // La pile commence à l'appelant, pas dans ce constructeur.
    Error.captureStackTrace?.(this, new.target);
  }

  /** Forme structurée pour la journalisation. */
  toLog() {
    return { code: this.code, expected: this.expected, ...this.context };
  }
}

/**
 * Commande refusée faute de rôle (socle §8.3). La réponse est éphémère et
 * aucune trace ne part dans les salons de logs.
 */
export class PermissionDeniedError extends AppError {
  constructor(command, context = {}) {
    super(`commande refusée : ${command}`, {
      code: 'permission_denied',
      template: 'command_denied',
      context: { command, ...context },
    });
  }
}

/**
 * Fonctionnalité désactivée : référence Discord introuvable au démarrage
 * (socle §5.5) ou couche Minecraft inerte (socle §11).
 *
 * Le bot répond qu'elle est indisponible — il ne plante pas, et ne fait pas
 * comme si de rien n'était.
 */
export class FeatureUnavailableError extends AppError {
  constructor(capability, context = {}) {
    super(`fonctionnalité indisponible : ${capability}`, {
      code: 'feature_unavailable',
      template: 'feature_unavailable',
      context: { capability, ...context },
    });
  }
}

/**
 * Une erreur était-elle prévue ?
 *
 * Tout ce qui n'est pas un AppError opérationnel est un défaut du code : une
 * TypeError venue d'un appel Discord n'a rien d'attendu, même si elle survient
 * dans un chemin de traitement d'erreur.
 */
export const isExpected = (error) => error instanceof AppError && error.expected;

/** Enveloppe une valeur rejetée en Error. Une promesse peut rejeter n'importe quoi. */
export function toError(value) {
  if (value instanceof Error) return value;

  const error = new Error(
    `rejet non-Error (${typeof value}) : ${safeDescribe(value)}`,
  );
  error.cause = value;

  return error;
}

function safeDescribe(value) {
  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Référence circulaire ou getter qui jette : la description ne doit pas
    // faire échouer le traitement de l'erreur qu'elle décrit.
    return Object.prototype.toString.call(value);
  }
}
