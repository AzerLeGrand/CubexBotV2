/**
 * Registre de purge (socle §10).
 *
 * Aucun module n'écrit sa propre logique de suppression : chacun déclare ce
 * qu'il conserve et pour combien de temps, une tâche unique s'occupe du reste.
 * Une logique de suppression par module, c'est autant d'occasions d'oublier une
 * table ou de se tromper de colonne.
 *
 * Les fichiers de journaux ne passent pas par ici : leur transport les purge
 * lui-même. Le registre est typé pour du SQL, lui greffer une seconde nature
 * pour un seul cas le compliquerait plus qu'il ne le simplifierait.
 */

const MS_PER_DAY = 86_400_000;

/**
 * Identifiants SQL admis.
 *
 * Table et colonne sont interpolées dans la requête — SQLite ne les accepte pas
 * en paramètre liés. Elles viennent du code des modules et non d'une saisie,
 * mais la validation ferme la porte plutôt que de compter dessus.
 */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * @param {object} options
 * @param {object} options.database
 * @param {object} options.config
 * @param {object} options.logger
 * @param {object} [options.shutdown] séquence d'arrêt, pour y inscrire l'annulation
 */
export function createPurgeRegistry({ database, config, logger, shutdown = null }) {
  /** @type {{ owner: string, table: string, dateColumn: string, retentionKey: string }[]} */
  const entries = [];

  let timer = null;

  /**
   * Inscrit les déclarations d'un module.
   *
   * @param {string} owner nom du module, pour le compte rendu
   * @param {{ table: string, date_column: string, retention_key: string }[]} declarations
   */
  function register(owner, declarations = []) {
    for (const declaration of declarations) {
      const { table, date_column: dateColumn, retention_key: retentionKey } = declaration;

      for (const [field, value] of [['table', table], ['date_column', dateColumn]]) {
        if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
          throw new Error(
            `déclaration de purge invalide pour ${owner} : ${field} attend un identifiant SQL ` +
              `simple, reçu ${JSON.stringify(value)}`,
          );
        }
      }

      if (typeof retentionKey !== 'string' || retentionKey.length === 0) {
        throw new Error(`déclaration de purge invalide pour ${owner} : retention_key manquante`);
      }

      entries.push({ owner, table, dateColumn, retentionKey });
    }
  }

  /**
   * Exécute la purge sur toutes les tables déclarées.
   *
   * Une erreur sur une table n'interrompt pas les autres : une rétention mal
   * configurée dans un module ne doit pas empêcher les trente autres tables
   * d'être nettoyées.
   *
   * La comparaison suppose des horodatages **ISO 8601 en TEXT**, convention du
   * projet : sur cette forme, l'ordre lexicographique est l'ordre
   * chronologique.
   *
   * @returns {{ owner: string, table: string, deleted?: number, error?: string }[]}
   */
  function run() {
    const report = [];

    for (const entry of entries) {
      try {
        const days = config.get(entry.retentionKey);
        const cutoff = new Date(Date.now() - days * MS_PER_DAY).toISOString();

        const info = database
          .prepare(`DELETE FROM ${entry.table} WHERE ${entry.dateColumn} < ?`)
          .run(cutoff);

        report.push({ owner: entry.owner, table: entry.table, deleted: info.changes });
      } catch (cause) {
        report.push({ owner: entry.owner, table: entry.table, error: cause.message });

        logger.error('purge impossible sur une table', {
          owner: entry.owner,
          table: entry.table,
          retention_key: entry.retentionKey,
          error: cause,
        });
      }
    }

    const deleted = report.reduce((sum, line) => sum + (line.deleted ?? 0), 0);
    const failed = report.filter((line) => line.error !== undefined).length;

    // Compte rendu par table, en fichier. Le relais vers le salon `bot` sera
    // ajouté en phase 6.
    logger.info('purge quotidienne terminée', { deleted, failed, tables: report });

    return report;
  }

  /** Arme la prochaine exécution, puis se réarme après chaque passage. */
  function schedule() {
    const hour = config.get('purge.hour');
    const timezone = config.get('bot.timezone');
    const delay = msUntilNextRun(hour, timezone);

    timer = setTimeout(() => {
      try {
        run();
      } catch (cause) {
        // Aucune défaillance de la purge ne doit interrompre la planification :
        // le bot tournerait alors sans jamais purger, en silence.
        logger.error('purge quotidienne interrompue', { error: cause });
      }

      schedule();
    }, delay);

    // La purge ne doit pas maintenir le processus en vie à elle seule.
    timer.unref?.();

    logger.info('purge planifiée', { hour, timezone, in_ms: delay });
  }

  const registry = {
    register,
    run,

    /** Nombre de déclarations inscrites. */
    get size() {
      return entries.length;
    },

    start() {
      if (timer === null) schedule();
      return registry;
    },

    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };

  shutdown?.register('purge', () => registry.stop());

  return registry;
}

/**
 * Millisecondes avant la prochaine occurrence de `hour` dans le fuseau donné.
 *
 * Le calcul passe par l'heure locale du fuseau et non par l'heure UTC : à 4h00
 * heure de Paris correspondent 2h ou 3h UTC selon la saison.
 *
 * Un changement d'heure décale l'exécution d'une heure ce jour-là — 3h ou 5h au
 * lieu de 4h. Sans conséquence sur une purge nocturne, et le calcul suivant se
 * recale de lui-même.
 */
export function msUntilNextRun(hour, timezone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    // h23 force 00–23 : en h24, minuit se lit « 24 » et fausserait le calcul.
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);

  const at = (type) => Number(parts.find((part) => part.type === type).value);

  const elapsed = at('hour') * 3600 + at('minute') * 60 + at('second');
  const target = hour * 3600;

  const seconds = target > elapsed ? target - elapsed : target - elapsed + 86_400;

  return seconds * 1000;
}
