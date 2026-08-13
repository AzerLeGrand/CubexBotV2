import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

import { fromRoot, isAbsolutePath } from '../../utils/paths.js';
import { CORE_OWNER, MigrationError, runMigrations } from './migrations.js';

/**
 * Connexion SQLite (socle §6).
 *
 * `better-sqlite3` est synchrone : aucune promesse, aucun pool, aucune écriture
 * concurrente à arbitrer. C'est ce qui rend la fermeture propre simple à
 * garantir.
 */

/**
 * Attente sur une base verrouillée, quand la configuration n'en fournit pas.
 *
 * En exploitation, la valeur vient toujours de `database.busy_timeout_ms` : ce
 * n'est pas une garantie de durabilité mais un réglage d'exploitation, et sur
 * un disque lent la valeur ci-dessous peut devenir insuffisante. Ce défaut ne
 * sert qu'aux appels hors bootstrap, tests compris.
 */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * Ouvre la base et applique les réglages de connexion.
 *
 * @param {object} options
 * @param {string} options.file chemin du fichier, absolu ou relatif à la racine du projet
 * @param {number} [options.busyTimeoutMs] issu de `config.yml`
 */
export function openDatabase({ file, busyTimeoutMs = DEFAULT_BUSY_TIMEOUT_MS }) {
  // Détection portable : un `C:\…` arrivé jusqu'ici sur Linux ne doit pas être
  // pris pour un chemin relatif et collé derrière la racine du projet. La
  // validation le refuse en amont ; ceci évite qu'un appel direct produise un
  // chemin absurde plutôt qu'une erreur lisible.
  const path = isAbsolutePath(file) ? file : fromRoot(file);

  // Le dossier data/ est exclu de Git : il n'existe pas sur une installation
  // neuve.
  mkdirSync(dirname(path), { recursive: true });

  const db = new BetterSqlite3(path);

  // WAL est persistant, inscrit dans le fichier ; les autres réglages valent
  // pour la connexion et se redonnent à chaque ouverture.
  const mode = db.pragma('journal_mode = WAL', { simple: true });

  if (String(mode).toLowerCase() !== 'wal') {
    db.close();

    // Arrive sur un montage réseau, où SQLite refuse WAL en silence et retombe
    // sur le journal par défaut.
    throw new MigrationError(`mode WAL refusé par le système de fichiers (obtenu : ${mode})`, {
      file: path,
      mode,
    });
  }

  // Sans ce réglage, SQLite accepte les clés étrangères dans le schéma mais ne
  // les applique pas : les contraintes deviennent décoratives.
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);

  // NORMAL est le compagnon recommandé de WAL : durabilité conservée en cas de
  // plantage du processus, seule une panne de courant peut coûter la dernière
  // transaction.
  //
  // En dur au titre de la seconde exception de CLAUDE.md — configurer une
  // garantie revient à permettre de la contourner : la clé permettrait
  // d'écrire `OFF`, et le bot perdrait des écritures sur coupure sans que rien
  // ne le signale.
  db.pragma('synchronous = NORMAL');

  return { db, path };
}

/**
 * Crée la façade de base de données.
 *
 * @param {object} options
 * @param {string} options.file     chemin issu de `config.yml`, jamais d'un chemin en dur
 * @param {object} options.logger   journalisation injectée
 * @param {number} [options.busyTimeoutMs] issu de `config.yml`
 * @param {object} [options.shutdown] séquence d'arrêt, pour y inscrire la fermeture
 */
export function createDatabase({ file, logger, busyTimeoutMs, shutdown = null }) {
  const { db, path } = openDatabase({ file, busyTimeoutMs });

  let closed = false;

  const database = {
    /** Chemin réellement ouvert, une fois résolu. */
    path,

    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    transaction: (fn) => db.transaction(fn),

    /**
     * Instance `better-sqlite3` brute.
     *
     * Cette façade ne prétend pas isoler la bibliothèque — `prepare()` rend
     * déjà des objets qui lui appartiennent. Elle existe pour tenir les
     * réglages d'ouverture et la fermeture au même endroit, pas pour permettre
     * d'en changer sans rien réécrire.
     */
    raw: db,

    /**
     * Applique les migrations en attente.
     *
     * @param {{ owner: string, directory: string }[]} sources
     */
    migrate: (sources) => {
      const result = runMigrations(db, sources, { logger });

      logger.info('migrations à jour', {
        applied: result.applied.length,
        total: result.total,
      });

      return result;
    },

    /**
     * Checkpoint WAL puis fermeture.
     *
     * `TRUNCATE` replie le journal dans la base et remet le fichier `-wal` à
     * zéro : le prochain démarrage repart d'un état net, et une copie du seul
     * fichier `.sqlite` est complète.
     */
    close: () => {
      if (closed) return;
      closed = true;

      try {
        db.pragma('wal_checkpoint(TRUNCATE)');
      } catch (cause) {
        // Un checkpoint refusé ne doit pas empêcher la fermeture : les données
        // sont déjà durables dans le WAL, elles seront reprises au démarrage.
        logger.warn('checkpoint WAL impossible avant fermeture', { error: cause });
      }

      db.close();
      logger.info('base de données fermée', { path });
    },
  };

  // Le plafond de 3 s de la séquence d'arrêt couvre le checkpoint : voir
  // l'invariant du socle §3.
  shutdown?.register('database', () => database.close());

  return database;
}

export { CORE_OWNER, MigrationError } from './migrations.js';
