import { toError } from './app-error.js';

/**
 * Arrêt du bot : séquence de fermeture, signaux et gestionnaire de dernier
 * recours.
 *
 * Deux chemins d'entrée, une seule séquence de sortie.
 *
 * | Déclencheur | Nature | Code | Niveau |
 * |---|---|---|---|
 * | SIGTERM, SIGINT | arrêt demandé | 0 | `info` |
 * | uncaughtException, unhandledRejection | défaillance | 1 | `error` |
 *
 * Un signal est un arrêt normal : rien ne va mal, on nous demande de partir.
 * Le journaliser en `error` déclencherait des alertes à chaque déploiement.
 *
 * Une exception non capturée laisse en revanche le processus dans un état
 * indéterminé — ressources à moitié libérées, transaction ouverte, client
 * Discord dont on ne sait plus s'il écoute. Continuer produirait un bot qui
 * répond à moitié, pire qu'un bot arrêté : pm2 le redémarre en quelques
 * secondes.
 *
 * Reçoit son logger par injection : ce fichier n'importe aucune bibliothèque de
 * journalisation.
 */

/**
 * Plafond par étape de fermeture, en millisecondes.
 *
 * En dur, et non dans `config.yml` : la séquence doit fonctionner avant que la
 * configuration ne soit lue, précisément pour couvrir les défaillances du
 * démarrage. Reste surchargeable par paramètre.
 *
 * **La somme des plafonds doit rester strictement inférieure au `kill_timeout`
 * de `ecosystem.config.cjs`**, faute de quoi pm2 tue le bot au milieu de sa
 * fermeture.
 */
export const DEFAULT_STEP_TIMEOUT_MS = 3_000;

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;

/**
 * Construit la séquence d'arrêt.
 *
 * @param {object} options
 * @param {object} options.logger              journalisation injectée
 * @param {(code: number) => void} [options.exit]
 * @param {NodeJS.EventEmitter} [options.target] cible des écouteurs, `process` par défaut
 * @param {number} [options.stepTimeoutMs]     plafond par défaut de chaque étape
 */
export function createShutdown({
  logger,
  exit = (code) => process.exit(code),
  target = process,
  stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
}) {
  /**
   * Le drain des journaux est inscrit d'office, en premier — donc exécuté en
   * dernier. Impossible de l'oublier, et l'entrée qui explique l'arrêt part
   * bien sur le disque.
   */
  const steps = [{ name: 'logging', close: () => logger.close(), timeoutMs: stepTimeoutMs }];

  let running = false;

  /**
   * Inscrit une ressource à fermer. La base et le client Discord viendront s'y
   * greffer sans que ce fichier ne les connaisse.
   *
   * @param {string} name nom porté par le journal
   * @param {() => unknown} close fermeture, synchrone ou non
   */
  function register(name, close, { timeoutMs = stepTimeoutMs } = {}) {
    steps.push({ name, close, timeoutMs });

    return () => {
      const index = steps.findIndex((step) => step.name === name);
      if (index > 0) steps.splice(index, 1);
    };
  }

  /**
   * Déroule la séquence puis sort.
   *
   * Les étapes se ferment dans l'ordre inverse de leur inscription : on ferme
   * comme on a ouvert, à l'envers. Une étape en échec ou expirée n'empêche
   * jamais les suivantes — une base qui refuse son checkpoint ne doit pas
   * emporter le drain des journaux avec elle.
   */
  async function run({ reason, code, level, context = {} }) {
    // Une seconde secousse pendant l'arrêt ne relance pas la séquence : elle
    // couperait la fermeture en cours et ferait perdre l'entrée qui explique
    // tout.
    if (running) return;
    running = true;

    logger[level](`arrêt du bot : ${reason}`, context);

    for (const step of [...steps].reverse()) {
      const failure = await settle(step.close, step.timeoutMs);

      // Le journal est la dernière étape : se plaindre de son échec après
      // l'avoir fermé ne mènerait nulle part, mais l'appel reste inoffensif.
      if (failure) {
        logger.warn(`fermeture incomplète : ${step.name}`, { step: step.name, reason: failure });
      }
    }

    exit(code);
  }

  /**
   * Pose les écouteurs.
   *
   * SIGTERM et SIGINT sont écoutés tous les deux, quelle que soit la valeur de
   * `kill_signal` : le premier couvre un arrêt système, le second pm2 — dont le
   * défaut est SIGINT — et le Ctrl+C du poste de développement.
   *
   * @returns {() => void} retire les écouteurs posés
   */
  function install() {
    const onSignal = (signal) => () =>
      run({ reason: `signal ${signal}`, code: EXIT_SUCCESS, level: 'info', context: { signal } });

    const onFatal = (kind) => (value) =>
      run({
        reason: kind,
        code: EXIT_FAILURE,
        level: 'error',
        context: { kind, error: toError(value) },
      });

    const listeners = [
      ['SIGTERM', onSignal('SIGTERM')],
      ['SIGINT', onSignal('SIGINT')],
      ['uncaughtException', onFatal('uncaughtException')],
      ['unhandledRejection', onFatal('unhandledRejection')],
    ];

    for (const [event, listener] of listeners) target.on(event, listener);

    return () => {
      for (const [event, listener] of listeners) target.off(event, listener);
    };
  }

  return { register, install, run };
}

/**
 * Exécute une fermeture sans jamais laisser échapper d'erreur.
 *
 * @returns {Promise<string|null>} motif de l'échec, ou `null` si tout s'est bien passé
 */
function settle(close, timeoutMs) {
  let timer;

  const expiry = new Promise((resolve) => {
    // unref : cette minuterie ne doit pas maintenir le processus en vie quand
    // la fermeture se termine avant elle.
    timer = setTimeout(() => resolve(`délai de ${timeoutMs} ms dépassé`), timeoutMs);
    timer.unref?.();
  });

  const attempt = (async () => {
    try {
      await close();
      return null;
    } catch (cause) {
      return cause?.message ?? String(cause);
    }
  })();

  return Promise.race([attempt, expiry]).finally(() => clearTimeout(timer));
}
