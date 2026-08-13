import { render } from '../../utils/template.js';

import { ConfigValidationError } from './errors.js';
import { loadYamlFiles } from './loader.js';
import { configDir } from '../../utils/paths.js';
import { ConfigStore, resolve } from './store.js';
import { validate } from './validate.js';

/**
 * Façade du module de configuration. C'est ce qui entre dans le `ctx` des
 * modules.
 *
 * L'objet est un ACCESSEUR, jamais un instantané : `config.get(path)` résout au
 * moment de l'usage. Un module qui déstructure la configuration dans son `init`
 * fige la valeur et cesse de voir les rechargements.
 */

/**
 * Entrées conservées tant qu'aucun logger n'est injecté.
 *
 * Le premier chargement précède forcément la création du logger — son niveau et
 * sa rétention viennent de `config.yml`. Sans ce tampon, tout ce que la
 * configuration a à dire de sa propre mise en route serait perdu.
 */
const BUFFERED_ENTRIES_MAX = 100;

export class Configuration {
  #store = new ConfigStore();
  #dir;
  #options;
  #logger = null;
  #buffer = [];

  /**
   * @param {object} [options]
   * @param {string} [options.dir] dossier des trois YAML
   * @param {object} [options.logger] journalisation, injectable plus tard
   */
  constructor({ dir = configDir, logger = null, ...options } = {}) {
    this.#dir = dir;
    this.#options = options;
    if (logger) this.setLogger(logger);
  }

  // -------------------------------------------------------------------------
  // Cycle de vie
  // -------------------------------------------------------------------------

  /**
   * Premier chargement. Une configuration invalide arrête le bot (socle §5.4) :
   * la levée est le moyen de le garantir, l'appelant affiche `formatErrors()`
   * avant de sortir.
   *
   * @returns {{ warnings: ConfigError[] }}
   * @throws {ConfigValidationError}
   */
  load() {
    const { data, errors, warnings } = this.#read();

    if (errors.length > 0) throw new ConfigValidationError(errors);

    this.#store.replace(data, { initial: true });
    this.#report(warnings);

    return { warnings };
  }

  /**
   * Rechargement à chaud (socle §5.6).
   *
   * Ne lève jamais : une configuration invalide laisse l'ancienne en place et
   * le bot continue de tourner. C'est tout l'intérêt de la commande — un
   * rechargement raté ne doit pas coûter plus cher qu'un rechargement évité.
   *
   * @param {object} [context] transmis aux abonnés et journalisé, dont `actor`
   * @returns {{ ok: boolean, errors: ConfigError[], warnings: ConfigError[] }}
   */
  reload(context = {}) {
    let result;

    try {
      result = this.#read();
    } catch (cause) {
      // Défaillance imprévue de lecture : la configuration en place survit.
      this.#log('error', 'rechargement de configuration interrompu', {
        ...context,
        error: cause.message,
      });

      return { ok: false, errors: [], warnings: [], failure: cause };
    }

    const { data, errors, warnings } = result;

    if (errors.length > 0) {
      this.#log('warn', 'rechargement de configuration refusé', {
        ...context,
        count: errors.length,
      });

      return { ok: false, errors, warnings };
    }

    this.#store.replace(data, context);
    this.#report(warnings);
    this.#log('info', 'configuration rechargée', { ...context, warnings: warnings.length });

    return { ok: true, errors: [], warnings };
  }

  /**
   * Lit et valide les trois fichiers sans rien remplacer.
   *
   * Les anomalies de CHARGEMENT et de VALIDATION sont concaténées : un
   * `messages.yml` absent est signalé par le chargeur et laisse `validate()`
   * sans rien à redire. Ne regarder que la seconde liste ferait démarrer le bot
   * sur un fichier manquant.
   */
  #read() {
    const { files, errors: loadErrors } = loadYamlFiles({ dir: this.#dir });
    const { data, errors: validationErrors, warnings } = validate(files, this.#options);

    const errors = [...loadErrors, ...validationErrors];

    return { data: errors.length === 0 ? data : null, errors, warnings };
  }

  // -------------------------------------------------------------------------
  // Lecture
  // -------------------------------------------------------------------------

  get loaded() {
    return this.#store.loaded;
  }

  /** Lecture d'un réglage, au moment de l'usage. Voir `ConfigStore.get`. */
  get(path, ...fallback) {
    return this.#store.get(path, ...fallback);
  }

  /**
   * Arbre complet de `config.yml`.
   *
   * Réservé à ce qui doit parcourir la configuration plutôt que la lire — la
   * vérification des références Discord, notamment. Les lectures ordinaires
   * passent par `get()`, seul moyen de ne pas figer une valeur.
   */
  get raw() {
    return this.#store.config;
  }

  /**
   * Rend un texte de `messages.yml`.
   *
   * Consomme le `missing` du moteur de substitution et le journalise : le
   * contrat du moteur ne remonte rien si personne ne l'écoute. Une clé
   * introuvable est rendue telle quelle plutôt que vide — un `commands.denied`
   * affiché en clair se remarque, une bulle vide non.
   *
   * @param {string} key chemin pointé dans messages.yml
   * @param {Record<string, unknown>} [variables]
   * @returns {string}
   */
  text(key, variables = {}) {
    const value = resolve(this.#store.messages, key);

    if (value === undefined) {
      this.#log('error', 'texte absent de messages.yml', { key });
      return key;
    }

    const { text, missing } = render(value, variables);

    if (missing.length > 0) {
      this.#log('error', 'variables non fournies au gabarit', { key, missing });
    }

    return text;
  }

  /**
   * Gabarit d'`embeds.yml`, tel que validé. Le rendu en embed Discord
   * appartient au moteur d'embeds, qui appelle `text()` pour chaque `*_key`.
   */
  template(name) {
    const value = resolve(this.#store.embeds, `templates.${name}`);

    if (value === undefined) this.#log('error', 'gabarit absent de embeds.yml', { name });

    return value;
  }

  /** Palette de la marque, telle que déclarée dans `embeds.yml`. */
  get colors() {
    return this.#store.embeds?.colors ?? null;
  }

  /** Pied de page commun à tous les embeds. */
  get footer() {
    return this.#store.embeds?.footer ?? null;
  }

  // -------------------------------------------------------------------------
  // Abonnement
  // -------------------------------------------------------------------------

  /** Prévenu à chaque remplacement réussi, avec `{ previous, current, actor }`. */
  on(event, listener) {
    this.#store.on(event, listener);
    return this;
  }

  off(event, listener) {
    this.#store.off(event, listener);
    return this;
  }

  // -------------------------------------------------------------------------
  // Journalisation
  // -------------------------------------------------------------------------

  /**
   * Injecte la journalisation et rejoue ce qui a été dit avant elle.
   *
   * Le module n'importe jamais le logger : la validation doit journaliser, et
   * le logger se règle depuis la configuration — l'import créerait le cycle
   * `config → logging → config`.
   */
  setLogger(logger) {
    this.#logger = logger;

    const pending = this.#buffer;
    this.#buffer = [];

    for (const { level, message, context } of pending) logger[level](message, context);

    return this;
  }

  #log(level, message, context) {
    if (this.#logger !== null) {
      this.#logger[level](message, context);
      return;
    }

    if (this.#buffer.length < BUFFERED_ENTRIES_MAX) {
      this.#buffer.push({ level, message, context });
    }
  }

  /** Les sections orphelines sont dites une fois, à chaque chargement réussi. */
  #report(warnings) {
    for (const warning of warnings) {
      this.#log('warn', warning.message, { file: warning.file, key: warning.key });
    }
  }
}

/** Fabrique de confort : construit et charge d'un seul geste. */
export function loadConfiguration(options = {}) {
  const configuration = new Configuration(options);

  configuration.load();

  return configuration;
}
