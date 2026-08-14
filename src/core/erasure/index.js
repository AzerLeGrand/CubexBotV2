import { findColumn, tableColumns } from '../database/schema-info.js';
import { AppError } from '../errors/app-error.js';

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

/** Nom de la colonne telle que déclarée, replié pour la comparaison. */
const userColumnOf = (column) => column.name.toLowerCase();

/**
 * Cite un nom d'index dans un PRAGMA.
 *
 * Celui-ci vient de SQLite et non d'une déclaration de module — `IDENTIFIER` ne
 * l'a donc pas filtré, et un index nommé depuis une migration peut porter ce
 * qu'il veut.
 */
const quote = (name) => `"${String(name).replaceAll('"', '""')}"`;

export function createErasureRegistry({ database, logger }) {
  /** @type {{ owner: string, table: string, userColumn: string, strategy: string }[]} */
  const entries = [];

  /**
   * Inscrit les déclarations d'un module.
   *
   * L'ordre des contrôles compte : identifiants SQL, puis stratégie, puis
   * inspection de la table. Inspecter d'abord ferait répondre « table absente »
   * à une déclaration dont le vrai défaut est ailleurs.
   *
   * @param {string} owner
   * @param {{ table: string, user_column: string, strategy: 'delete'|'anonymize' }[]} declarations
   */
  function register(owner, declarations = []) {
    for (const declaration of declarations) {
      const { table, user_column: userColumn, strategy } = declaration;

      const fault = (message) => {
        throw new AppError(`déclaration d'effacement invalide pour ${owner} : ${message}`, {
          code: 'erasure_invalid',
          context: { owner, table, column: userColumn, strategy },
          expected: false,
        });
      };

      for (const [field, value] of [['table', table], ['user_column', userColumn]]) {
        if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
          fault(`${field} attend un identifiant SQL simple, reçu ${JSON.stringify(value)}`);
        }
      }

      if (!STRATEGIES.includes(strategy)) {
        fault(`strategy attend ${STRATEGIES.join(' ou ')}, reçu ${JSON.stringify(strategy)}`);
      }

      inspect(table, userColumn, strategy, fault);

      entries.push({ owner, table, userColumn, strategy });
    }
  }

  /**
   * Vérifie que la table peut porter la stratégie déclarée.
   *
   * Possible parce que les migrations s'appliquent AVANT l'inscription des
   * modules : à l'étape 3 de `src/index.js` pour les premières, à l'étape 5
   * pour la seconde. Les tables existent quand on arrive ici.
   */
  function inspect(table, userColumn, strategy, fault) {
    const columns = tableColumns(database, table);

    // Une table absente rend une liste vide plutôt que de lever. Sans ce
    // contrôle, l'anomalie ne sortirait qu'au premier effacement réel, sous la
    // forme d'un « no such table » qui annulerait toute la transaction — les
    // tables des autres modules comprises.
    if (columns.length === 0) fault(`la table ${table} n'existe pas`);

    const column = findColumn(columns, userColumn);

    if (column === undefined) fault(`la colonne ${userColumn} n'existe pas dans ${table}`);

    if (strategy !== 'anonymize') return;

    const constraint = uniqueConstraintOn(table, column, columns);

    if (constraint !== null) {
      // Le deuxième effacement écrirait une seconde fois ANONYMOUS_USER_ID sur
      // une colonne qui ne l'admet qu'une fois. L'exception remonterait, et
      // l'effacement étant atomique, elle annulerait tout — y compris les
      // tables des autres modules. Le premier passerait, tous les suivants
      // échoueraient.
      fault(
        `anonymize est impossible sur ${table}.${userColumn} : la colonne appartient à ` +
          `${constraint}. Le deuxième effacement heurterait la ligne déjà anonymisée et ` +
          'annulerait toute la transaction. Utiliser strategy « delete », ou une table dont ' +
          'la colonne membre n\'est pas la clé',
      );
    }
  }

  /**
   * La colonne appartient-elle à une contrainte d'unicité ?
   *
   * Les deux sources sont nécessaires, et c'est le résultat d'une mesure :
   *
   * - `table_info` seul voit `INTEGER PRIMARY KEY`, l'alias de rowid, pour
   *   lequel SQLite ne crée AUCUN index — `index_list` rend une liste vide. Un
   *   contrôle bâti sur les index manquerait la forme la plus courante ;
   * - `index_list` seul voit les contraintes UNIQUE et les index uniques
   *   explicites, que `table_info` ignore.
   *
   * @returns {string|null} description de la contrainte, ou `null` si la
   *   colonne est libre
   */
  function uniqueConstraintOn(table, column, columns) {
    // `pk` porte la POSITION dans la clé primaire, pas un booléen : c'est ce
    // qui permet de nommer la clé composite dans le refus. Une clé
    // (user_id, guild_id) collisionne dès que deux membres du même serveur
    // sont effacés — l'appartenance suffit, la nuance n'apporte rien.
    if (column.pk > 0) {
      const key = columns.filter((held) => held.pk > 0).sort((a, b) => a.pk - b.pk);

      return key.length > 1
        ? `la clé primaire composite (${key.map((held) => held.name).join(', ')})`
        : 'la clé primaire';
    }

    for (const index of database.prepare(`PRAGMA index_list(${table})`).all()) {
      if (index.unique !== 1) continue;

      // `index_info` et NON `index_xinfo` : sur une table WITHOUT ROWID, xinfo
      // rend aussi les colonnes NON clés, et n'importe laquelle passerait pour
      // membre de la contrainte. Le faux positif serait bloquant au démarrage,
      // sur une table parfaitement saine.
      const members = database.prepare(`PRAGMA index_info(${quote(index.name)})`).all();

      // Un index sur expression — CREATE UNIQUE INDEX ix ON t(lower(user_id)) —
      // rend `cid: -2, name: null` : sa colonne n'est pas nommée, donc pas
      // détectable ici. Limite connue et assumée, aucune migration du projet
      // n'en déclare.
      if (!members.some((member) => member.name?.toLowerCase() === userColumnOf(column))) continue;

      const shape =
        index.origin === 'pk'
          ? 'la clé primaire'
          : index.origin === 'u'
            ? 'une contrainte UNIQUE'
            : `l'index unique « ${index.name} »`;

      const composite =
        members.length > 1
          ? ` composite (${members.map((member) => member.name ?? '?').join(', ')})`
          : '';

      // Un unique partiel collisionne quand même à l'intérieur de son
      // sous-ensemble : refusé au même titre.
      const partial = index.partial === 1 ? ', partielle' : '';

      return `${shape}${composite}${partial}`;
    }

    return null;
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
