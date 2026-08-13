import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

import BetterSqlite3 from 'better-sqlite3';

import { fromRoot } from '../config/paths.js';
import { CORE_OWNER, MigrationError, runMigrations } from './migrations.js';

/**
 * Connexion SQLite (socle §6).
 *
 * `better-sqlite3` est synchrone : aucune promesse, aucun pool, aucune écriture
 * concurrente à arbitrer. C'est ce qui rend la fermeture propre simple à
 * garantir.
 */

/**
 * Attente maximale sur une base verrouillée.
 *
 * Le bot est seul à écrire, mais un `sqlite3` lancé en SSH pour inspecter la
 * base peut tenir un verrou quelques instants. Sans ce délai, l'écriture
 * échouerait immédiatement sur SQLITE_BUSY.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * Ouvre la base et applique les réglages de connexion.
 *
 * @param {object} options
 * @param {string} options.file chemin du fichier, absolu ou relatif à la racine du projet
 */
export function openDatabase({ file }) {
  const path = isAbsolute(file) ? file : fromRoot(file);

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
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

  // NORMAL est le compagnon recommandé de WAL : durabilité conservée en cas de
  // plantage du processus, seule une panne de courant peut coûter la dernière
  // transaction.
  db.pragma('synchronous = NORMAL');

  return { db, path };
}

/**
 * Crée la façade de base de données.
 *
 * @param {object} options
 * @param {string} options.file     chemin issu de `config.yml`, jamais d'un chemin en dur
 * @param {object} options.logger   journalisation injectée
 * @param {object} [options.shutdown] séquence d'arrêt, pour y inscrire la fermeture
 */
export function createDatabase({ file, logger, shutdown = null }) {
  const { db, path } = openDatabase({ file });

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
