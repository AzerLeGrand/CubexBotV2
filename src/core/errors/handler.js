import { toError } from './app-error.js';

/**
 * Gestionnaire de dernier recours.
 *
 * Une exception non capturée ou une promesse rejetée sans traitement laisse le
 * processus dans un état indéterminé : des ressources à moitié libérées, une
 * transaction ouverte, un client Discord dont on ne sait plus s'il écoute.
 * Continuer produirait un bot qui répond à moitié, ce qui est pire qu'un bot
 * arrêté — pm2 le redémarre en quelques secondes.
 *
 * Reçoit son logger par injection, comme le module de configuration : ce
 * fichier n'importe aucune bibliothèque de journalisation.
 */

/**
 * Plafond d'attente du drain, en millisecondes.
 *
 * Ce délai n'est pas dans `config.yml` à dessein : le gestionnaire s'installe
 * avant que la configuration ne soit lue, précisément pour couvrir les
 * défaillances du démarrage. Il reste surchargeable par paramètre.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 3_000;

const EXIT_FAILURE = 1;

/**
 * Installe les gestionnaires globaux.
 *
 * @param {object} options
 * @param {object} options.logger              journalisation injectée
 * @param {() => Promise<void>} [options.drain] attente de l'écriture, `logger.close()` par défaut
 * @param {(code: number) => void} [options.exit]
 * @param {NodeJS.EventEmitter} [options.target] cible des écouteurs, `process` par défaut
 * @param {number} [options.drainTimeoutMs]
 * @returns {() => void} retire les écouteurs posés
 */
export function installGlobalHandlers({
  logger,
  drain = () => logger.close(),
  exit = (code) => process.exit(code),
  target = process,
  drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
}) {
  let shuttingDown = false;

  const fatal = (kind) => (value) => {
    // Une seconde secousse pendant l'arrêt ne relance pas la séquence : elle
    // couperait le drain en cours et ferait perdre l'entrée qui explique tout.
    if (shuttingDown) return;
    shuttingDown = true;

    const error = toError(value);

    logger.error(`arrêt du bot sur ${kind}`, { kind, error });

    // Le drain est attendu, mais jamais indéfiniment : un transport bloqué sur
    // un disque plein ne doit pas empêcher pm2 de redémarrer.
    withTimeout(drain(), drainTimeoutMs).then(
      () => exit(EXIT_FAILURE),
      () => exit(EXIT_FAILURE),
    );
  };

  const onUncaughtException = fatal('uncaughtException');
  const onUnhandledRejection = fatal('unhandledRejection');

  target.on('uncaughtException', onUncaughtException);
  target.on('unhandledRejection', onUnhandledRejection);

  return () => {
    target.off('uncaughtException', onUncaughtException);
    target.off('unhandledRejection', onUnhandledRejection);
  };
}

/** Résout au plus tard après `ms`, quoi qu'il advienne de la promesse. */
function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch(() => {}),
    new Promise((resolve) => {
      // unref : cette minuterie ne doit pas maintenir le processus en vie si
      // le drain se termine avant elle.
      setTimeout(resolve, ms).unref?.();
    }),
  ]);
}
