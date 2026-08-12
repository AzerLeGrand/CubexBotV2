const plural = (count, word) => (count > 1 ? `${word}s` : word);

/**
 * Une anomalie de configuration, localisée et lisible sans autre contexte.
 *
 * Ce n'est pas une exception : la validation en accumule des dizaines avant de
 * les présenter ensemble (socle §5.4). Seule ConfigValidationError se lève.
 */
export class ConfigError {
  /**
   * @param {object}   fields
   * @param {string}   fields.file    nom du fichier fautif (`config.yml`, `.env`)
   * @param {string[]} [fields.path]  chemin de la clé, du plus général au plus précis
   * @param {number}   [fields.line]  ligne, quand le fichier n'est pas analysable
   * @param {string}   fields.message ce qui ne va pas
   * @param {string}   [fields.hint]  comment le corriger
   */
  constructor({ file, path = [], line = null, message, hint = null }) {
    this.file = file;
    this.path = path;
    this.line = line;
    this.message = message;
    this.hint = hint;
  }

  /** Chemin pointé de la clé fautive, tel qu'il apparaît dans les messages. */
  get key() {
    return this.path.join('.');
  }

  /** `config.yml → roles.member`, `messages.yml (ligne 12)`, `.env` */
  get location() {
    if (this.path.length > 0) return `${this.file} → ${this.key}`;
    if (this.line !== null) return `${this.file} (ligne ${this.line})`;
    return this.file;
  }

  toString() {
    return `${this.location}: ${this.message}`;
  }
}

/**
 * Agrégat lançable. Porte la liste complète des anomalies, jamais la première
 * seule : corriger une configuration une erreur à la fois est intenable.
 */
export class ConfigValidationError extends Error {
  /**
   * @param {ConfigError[]} errors
   * @param {string} [summary] contexte de la validation (démarrage, rechargement)
   */
  constructor(errors, summary = 'Configuration invalide') {
    super(`${summary} — ${errors.length} ${plural(errors.length, 'erreur')}`);
    this.name = 'ConfigValidationError';
    this.errors = errors;
    this.summary = summary;
  }
}

/**
 * Rendu console, affiché au démarrage avant l'arrêt du processus.
 * Le rendu Discord du rechargement à chaud est ajouté avec la commande.
 */
export function formatErrors(errors, summary = 'Configuration invalide') {
  const lines = [`${summary} — ${errors.length} ${plural(errors.length, 'erreur')} :`, ''];

  for (const error of errors) {
    lines.push(`  ${error.location}`);
    lines.push(`    ${error.message}`);
    if (error.hint) lines.push(`    → ${error.hint}`);
    lines.push('');
  }

  return lines.join('\n');
}
