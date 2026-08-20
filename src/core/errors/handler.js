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
 * **La somme des plafonds doit rester strictement inférieure au
 * `TimeoutStopSec` de l'unité systemd `cubex-bot.service`**, faute de quoi le
 * superviseur envoie SIGKILL au milieu de la fermeture et le bot perd les
 * entrées de fin d'exécution. Ajouter une étape de fermeture impose de revoir
 * cette valeur des deux côtés.
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
 * @param {boolean} [options.diagnostic]       écrire le résumé fatal, voir `diagnose()`
 * @param {(text: string) => void} [options.stderr] destination de ce résumé
 */
export function createShutdown({
  logger,
  exit = (code) => process.exit(code),
  target = process,
  stepTimeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  diagnostic = true,
  // Enveloppée, et non passée par référence : `process.stderr.write` détachée
  // de son objet perd son `this` et lève au premier appel — au pire moment
  // possible, puisque c'est le traitement d'une défaillance.
  stderr = (text) => process.stderr.write(text),
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

    // Après la garde de réentrance, sinon une seconde secousse pendant la
    // fermeture produirait un second résumé alors que la séquence, elle, ne se
    // relance pas. Avant l'entrée de journal, et donc avant toute la séquence :
    // c'est ce qui rend le diagnostic indépendant du drain.
    if (code === EXIT_FAILURE) diagnose(reason, context);

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
   * Résumé de la défaillance sur stderr, sur le seul chemin d'échec.
   *
   * Hors développement, la journalisation n'écrit qu'en fichier JSON : sous pm2,
   * `pm2 logs` ne montre RIEN d'un processus qui sort en 1, et l'opérateur doit
   * savoir qu'il faut aller ouvrir `logs/cubex-AAAA-MM-JJ.log`. Les trois
   * blocages de démarrage — secrets manquants, configuration invalide,
   * manifeste illisible — passent déjà par stderr ; celui-ci manquait, alors
   * qu'il couvre le cas d'un module mal déclaré, refusé APRÈS la création du
   * logger.
   *
   * Surtout, le diagnostic journalisé dépend du drain de la journalisation :
   * disque plein, transport bloqué, et l'entrée qui explique la mort du bot est
   * précisément celle qui ne s'écrira pas. Celui-ci ne dépend d'aucun
   * transport et part avant la séquence de fermeture, dont une étape bloquée
   * peut retarder de plusieurs secondes.
   *
   * Un signal n'écrit rien : c'est un arrêt normal, et le journal suffit.
   */
  function diagnose(reason, context) {
    // La condition « la console porte déjà les entrées » est tranchée par
    // l'appelant et injectée. Ce fichier n'importe aucune bibliothèque de
    // journalisation et ne lit pas l'environnement : la lui faire déduire d'un
    // champ du logger l'obligerait à en connaître la forme au-delà de ses
    // quatre niveaux, et chaque logger factice devrait la mimer.
    if (!diagnostic) return;

    try {
      const error = context?.error;

      // `stack` commence déjà par « Nom: message » : l'ajouter serait redondant.
      const lines = [
        `arrêt du bot : ${reason}`,
        error?.stack ?? String(error?.message ?? error ?? 'aucune erreur fournie'),
      ];

      // La cause porte l'erreur d'origine — celle de `login()`, par exemple, que
      // le journal ne sérialise pas. Nom et message suffisent : la pile utile
      // est celle du dessus.
      const cause = error?.cause;

      if (cause) lines.push(`cause : ${cause.name ? `${cause.name}: ` : ''}${cause.message ?? cause}`);

      stderr(`${lines.join('\n')}\n`);
    } catch {
      // Un descripteur fermé ne doit pas faire échouer le traitement de
      // l'erreur : ce serait lever une seconde fois au pire endroit.
    }
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
