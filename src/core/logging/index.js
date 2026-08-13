import { createLogger as createWinstonLogger, format, transports } from 'winston';

import { RotatingFileTransport } from './rotating-file.js';

/**
 * Journalisation applicative (socle §7).
 *
 * **Ce dossier est le seul du projet à connaître winston.** Tout le reste passe
 * par l'interface ci-dessous. Le jour où la bibliothèque doit changer, elle
 * change ici et nulle part ailleurs — c'est ce qui a permis d'écarter sans
 * risque le transport de rotation abandonné.
 */

/** Les quatre niveaux du socle, du plus grave au plus bavard. */
const LEVELS = Object.freeze({ error: 0, warn: 1, info: 2, debug: 3 });

/** Module attribué aux entrées qui n'en déclarent pas. */
const ROOT_MODULE = 'core';

/**
 * Déplie les Error portées par le contexte.
 *
 * `format.errors()` ne traite que l'entrée elle-même. Une Error rangée dans le
 * contexte — `logger.error('appel échoué', { error })` — se sérialise en `{}`,
 * puisque `message` et `stack` ne sont pas énumérables. La pile disparaîtrait
 * du journal au moment précis où elle sert (socle §7).
 */
const unwrapErrors = format((info) => {
  for (const [key, value] of Object.entries(info)) {
    if (value instanceof Error) {
      info[key] = { name: value.name, message: value.message, stack: value.stack };
    }
  }

  return info;
});

/**
 * @param {object} options
 * @param {string} options.level          seuil de journalisation
 * @param {string} options.directory      dossier des fichiers
 * @param {string} options.filePrefix     préfixe des noms de fichier
 * @param {number} options.retentionDays  durée de conservation
 * @param {string} options.timezone       fuseau déterminant le changement de jour
 * @param {boolean} [options.console]     doubler sur la console (développement)
 * @returns {Logger}
 */
export function createLogger({
  level,
  directory,
  filePrefix,
  retentionDays,
  timezone,
  console: toConsole = false,
}) {
  const rotating = new RotatingFileTransport({
    directory,
    prefix: filePrefix,
    retentionDays,
    timezone,
  });

  const backend = createWinstonLogger({
    levels: LEVELS,
    level,
    // Une entrée JSON par ligne. L'ordre compte : `errors` déplie la pile avant
    // que `json` ne sérialise, sinon une Error se réduit à `{}`.
    format: format.combine(
      format.timestamp({ format: () => new Date().toISOString() }),
      format.errors({ stack: true }),
      unwrapErrors(),
      format.json(),
    ),
    transports: [rotating],
    // Une erreur de journalisation ne doit pas emporter le processus.
    exitOnError: false,
  });

  if (toConsole) {
    backend.add(
      new transports.Console({
        format: format.combine(format.colorize({ level: true }), format.simple()),
      }),
    );
  }

  backend.on('error', () => {
    // Le journal est le dernier endroit où se plaindre du journal. Sans cet
    // écouteur, l'événement 'error' d'un flux fermé ferait tomber le bot.
  });

  return wrap(backend, ROOT_MODULE, rotating);
}

/**
 * Interface exposée au reste du projet. Aucune méthode de winston ne traverse.
 *
 * @typedef {object} Logger
 * @property {(message: string, context?: object) => void} error
 * @property {(message: string, context?: object) => void} warn
 * @property {(message: string, context?: object) => void} info
 * @property {(message: string, context?: object) => void} debug
 * @property {(name: string) => Logger} forModule
 * @property {() => {deleted: number, failed: number}} sweep
 * @property {() => void} close
 */
function wrap(backend, module, rotating) {
  const write = (level) => (message, context) => {
    backend.log({ ...context, level, message, module });
  };

  return {
    error: write('error'),
    warn: write('warn'),
    info: write('info'),
    debug: write('debug'),

    /** Logger identique, dont les entrées portent le nom du module (socle §7). */
    forModule: (name) => wrap(backend, name, rotating),

    /** Purge immédiate des journaux échus. Le transport le fait déjà chaque jour. */
    sweep: () => rotating.sweep(),

    close: () => {
      backend.close();
      rotating.close();
    },
  };
}
