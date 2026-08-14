/**
 * Lecture du schéma d'une table, partagée par les registres.
 *
 * Purge et effacement sont symétriques et contrôlent la même chose à
 * l'inscription : que la table existe et qu'elle porte la colonne déclarée.
 * Deux implémentations divergeraient — la subtilité de la casse ci-dessous se
 * perdrait dans l'une des deux, et un module verrait sa déclaration acceptée
 * par un registre et refusée par l'autre.
 *
 * Ce qui n'est PAS ici : la recherche de contraintes d'unicité, qui n'a de sens
 * que pour la stratégie `anonymize` et reste donc dans le registre
 * d'effacement.
 */

/**
 * Colonnes d'une table, telles que SQLite les déclare.
 *
 * Une table absente rend une liste vide plutôt que de lever : c'est à
 * l'appelant de décider ce que cela vaut, et les deux registres en font un
 * refus au démarrage.
 *
 * @param {object} database façade de base de données
 * @param {string} table identifiant SQL déjà validé par l'appelant
 * @returns {{ name: string, type: string, notnull: number, pk: number }[]}
 */
export const tableColumns = (database, table) =>
  database.prepare(`PRAGMA table_info(${table})`).all();

/**
 * Retrouve une colonne par son nom.
 *
 * La comparaison est insensible à la casse : les identifiants SQLite le sont,
 * et le PRAGMA rend la colonne avec la casse de sa déclaration DDL. Une
 * comparaison stricte refuserait une table sur laquelle le SQL fonctionne
 * parfaitement — `User_Id` déclarée, `user_id` recherchée.
 *
 * `toLowerCase()` et non `toLocaleLowerCase()`, dont le résultat dépend de la
 * locale du processus.
 *
 * @returns {object | undefined}
 */
export const findColumn = (columns, name) =>
  columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
