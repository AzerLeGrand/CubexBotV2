/**
 * Registre d'effacement (socle §10, droit à l'effacement).
 *
 * Symétrique du registre de purge : aucun module n'écrit sa propre logique.
 * Sans registre, la première phase écrirait la sienne et les suivantes la
 * recopieraient — c'est exactement ce que le registre de purge évite.
 *
 * **Différence essentielle avec la purge : l'effacement est atomique.** Une
 * purge est une tâche récurrente, un échec partiel se rattrape le lendemain.
 * Un effacement est une obligation ponctuelle : partiellement exécuté puis
 * annoncé comme fait, il laisserait des données que le membre croit
 * supprimées.
 */

/**
 * Identifiant de remplacement des lignes anonymisées.
 *
 * `0` n'est jamais un identifiant Discord valide — ceux-ci font 17 à 20
 * chiffres — donc aucune collision avec un membre réel n'est possible.
 * L'affichage traduira cette valeur en texte, depuis `messages.yml`.
 */
export const ANONYMOUS_USER_ID = '0';

/** Mêmes contraintes que le registre de purge : les identifiants sont interpolés. */
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const STRATEGIES = Object.freeze(['delete', 'anonymize']);

export function createErasureRegistry({ database, logger }) {
  /** @type {{ owner: string, table: string, userColumn: string, strategy: string }[]} */
  const entries = [];

  /**
   * Inscrit les déclarations d'un module.
   *
   * @param {string} owner
   * @param {{ table: string, user_column: string, strategy: 'delete'|'anonymize' }[]} declarations
   */
  function register(owner, declarations = []) {
    for (const declaration of declarations) {
      const { table, user_column: userColumn, strategy } = declaration;

      for (const [field, value] of [['table', table], ['user_column', userColumn]]) {
        if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
          throw new Error(
            `déclaration d'effacement invalide pour ${owner} : ${field} attend un identifiant ` +
              `SQL simple, reçu ${JSON.stringify(value)}`,
          );
        }
      }

      if (!STRATEGIES.includes(strategy)) {
        throw new Error(
          `déclaration d'effacement invalide pour ${owner} : strategy attend ` +
            `${STRATEGIES.join(' ou ')}, reçu ${JSON.stringify(strategy)}`,
        );
      }

      entries.push({ owner, table, userColumn, strategy });
    }
  }

  /**
   * Compte ce qu'un effacement toucherait, sans rien modifier.
   *
   * Permet de confirmer avant d'agir : un effacement ne se défait pas.
   */
  function preview(userId) {
    return entries.map((entry) => ({
      owner: entry.owner,
      table: entry.table,
      strategy: entry.strategy,
      rows: database
        .prepare(`SELECT COUNT(*) AS n FROM ${entry.table} WHERE ${entry.userColumn} = ?`)
        .get(userId).n,
    }));
  }

  /**
   * Efface les données d'un membre, en une seule transaction.
   *
   * Contrairement à la purge, une erreur sur une table **annule tout**. Un
   * effacement à moitié fait est un effacement raté, et le signaler comme
   * réussi serait pire que d'échouer franchement.
   *
   * @returns {{ owner: string, table: string, strategy: string, affected: number }[]}
   */
  function erase(userId) {
    const report = [];

    const run = database.transaction(() => {
      for (const entry of entries) {
        const info =
          entry.strategy === 'delete'
            ? database
                .prepare(`DELETE FROM ${entry.table} WHERE ${entry.userColumn} = ?`)
                .run(userId)
            : database
                .prepare(
                  `UPDATE ${entry.table} SET ${entry.userColumn} = ? WHERE ${entry.userColumn} = ?`,
                )
                .run(ANONYMOUS_USER_ID, userId);

        report.push({
          owner: entry.owner,
          table: entry.table,
          strategy: entry.strategy,
          affected: info.changes,
        });
      }
    });

    try {
      run();
    } catch (cause) {
      logger.error('effacement annulé, aucune table modifiée', { user: userId, error: cause });
      throw cause;
    }

    const affected = report.reduce((sum, line) => sum + line.affected, 0);

    logger.info('effacement exécuté', { user: userId, affected, tables: report });

    return report;
  }

  return {
    register,
    preview,
    erase,

    get size() {
      return entries.length;
    },

    /** Tables déclarées, pour vérifier qu'aucune ne manque à l'appel. */
    tables: () => entries.map((entry) => `${entry.owner}/${entry.table}`),
  };
}
