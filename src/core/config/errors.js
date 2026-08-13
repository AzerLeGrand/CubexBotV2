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
 * Rendu compact tenant dans un budget de caractères, pour le message que
 * `/reload` renvoie au demandeur.
 *
 * La troncature se fait ICI, avant que le texte ne soit injecté dans le
 * gabarit : substituer d'abord puis couper ferait dépasser la limite de la
 * description d'embed sans que rien ne le rattrape, et couperait au milieu
 * d'une ligne.
 *
 * Aucune phrase de troncature n'est produite : `shown` et `total` sont
 * retournés pour que l'enveloppe, elle, vienne de messages.yml. Le hint reste
 * en console — mieux vaut afficher dix anomalies sans conseil que trois avec.
 *
 * @param {ConfigError[]} errors
 * @param {number} budget caractères restants pour la liste SEULE : la limite de
 *   la destination moins la longueur de l'enveloppe déjà rendue. Rendre
 *   l'enveloppe d'abord, la mesurer, puis appeler cette fonction. Lui passer la
 *   limite entière fait déborder au moment de la substitution, de toute la
 *   longueur de l'enveloppe.
 * @returns {{ text: string, shown: number, total: number, truncated: boolean }}
 */
export function formatErrorsWithin(errors, budget) {
  const lines = [];
  let used = 0;

  for (const error of errors) {
    const line = `${error.location} — ${error.message}`;
    const cost = line.length + (lines.length > 0 ? 1 : 0);

    if (used + cost > budget) break;

    lines.push(line);
    used += cost;
  }

  // Aucune anomalie ne tient : en montrer une coupée vaut mieux qu'un vide,
  // qui laisserait croire que la configuration est saine.
  if (lines.length === 0 && errors.length > 0 && budget > 1) {
    lines.push(`${errors[0].location} — ${errors[0].message}`.slice(0, budget - 1) + '…');
    return { text: lines[0], shown: 0, total: errors.length, truncated: true };
  }

  return {
    text: lines.join('\n'),
    shown: lines.length,
    total: errors.length,
    truncated: lines.length < errors.length,
  };
}

/**
 * Rendu console, affiché au démarrage avant l'arrêt du processus.
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
