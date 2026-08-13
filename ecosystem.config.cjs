// Configuration pm2. En CommonJS (.cjs) : le projet est en ESM, pm2 charge ce
// fichier avec require().
//
//   pm2 start ecosystem.config.cjs
//   pm2 restart cubex-bot
//   pm2 logs cubex-bot

/**
 * Budget d'arrêt.
 *
 * pm2 envoie son signal puis attend `kill_timeout` avant SIGKILL. Le défaut est
 * de 1600 ms : bien trop court ici, le bot serait tué au milieu de son drain à
 * chaque redémarrage et perdrait les entrées de fin d'exécution.
 *
 * La séquence de fermeture plafonne chaque étape à 3 s (DEFAULT_STEP_TIMEOUT_MS,
 * dans src/core/errors/handler.js) :
 *
 *   client Discord   3 s   fermeture du WebSocket, tributaire du réseau
 *   base SQLite      3 s   checkpoint WAL puis fermeture du fichier
 *   journaux         3 s   drain des tampons, en dernier pour relater le reste
 *   ------------------------
 *   pire cas         9 s
 *
 * 12 s laissent 3 s de marge, utiles sur un VPS de 1,8 Go dont une partie du
 * processus peut être en swap. Ce délai n'est subi que si le bot ne sort pas de
 * lui-même : en fonctionnement normal, la sortie est immédiate.
 *
 * **Invariant : la somme des plafonds d'étape reste strictement inférieure à
 * kill_timeout.** Ajouter une étape de fermeture impose de revoir cette valeur.
 */
const KILL_TIMEOUT_MS = 12_000;

module.exports = {
  apps: [
    {
      name: 'cubex-bot',
      script: 'src/index.js',

      // Un bot Discord ne se met pas en cluster : chaque instance ouvrirait sa
      // propre passerelle et traiterait les mêmes événements en double.
      exec_mode: 'fork',
      instances: 1,

      kill_timeout: KILL_TIMEOUT_MS,

      // Déclaré explicitement plutôt que subi. SIGTERM est le signal d'arrêt
      // conventionnel, celui que systemd emploie pour l'unité pm2-cubexbot.
      // Le gestionnaire écoute de toute façon SIGTERM et SIGINT, ce qui couvre
      // aussi le Ctrl+C du poste de développement.
      kill_signal: 'SIGTERM',

      autorestart: true,

      // Une boucle de redémarrage sur erreur de démarrage — configuration
      // invalide, jeton refusé — ne doit pas saturer le VPS.
      exp_backoff_restart_delay: 200,

      // Le bot tourne autour de 150 Mo. Au-delà de ce seuil, c'est une fuite :
      // mieux vaut un redémarrage propre qu'un OOM killer sur un VPS de 1,8 Go.
      max_memory_restart: '400M',

      // pm2 ne capture que ce qui échappe à winston. Les journaux applicatifs
      // vivent dans logs/, au format JSON, avec leur propre rotation.
      time: true,
      merge_logs: true,

      // Pas de bloc `env` : process.loadEnvFile() N'ÉCRASE PAS une variable
      // déjà présente dans l'environnement. Déclarer NODE_ENV ici le ferait
      // silencieusement gagner sur .env, et le même dépôt se comporterait
      // différemment selon qu'il tourne sous pm2 ou non. .env est la seule
      // source des secrets et de NODE_ENV (socle §5.7).
    },
  ],
};
