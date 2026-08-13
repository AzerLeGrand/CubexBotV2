import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AppError } from '../errors/app-error.js';

/**
 * Migrations SQL numérotées (socle §6).
 *
 * Une migration appliquée n'est jamais modifiée — on en ajoute une nouvelle.
 * Cette règle ne tient que si sa violation est détectée : le contenu de chaque
 * fichier est empreint à l'application, et l'empreinte est comparée au
 * démarrage suivant. Une divergence arrête le bot plutôt que de laisser une
 * base dans un état que personne ne sait décrire.
 */

/** `001_description.sql` — trois chiffres au moins, puis un nom en minuscules. */
const FILE_PATTERN = /^(\d{3,})_([a-z0-9_]+)\.sql$/;

const TABLE = 'schema_migrations';

/** Propriétaire des migrations du noyau. Les modules portent leur propre nom. */
export const CORE_OWNER = 'core';

/**
 * Anomalie de migration. Le bot ne démarre pas : aucun gabarit d'affichage,
 * personne ne la lira sur Discord.
 */
export class MigrationError extends AppError {
  constructor(message, context = {}, cause) {
    super(message, { code: 'migration_failed', context, cause, expected: false });
  }
}

/**
 * Empreinte du contenu d'une migration.
 *
 * Les fins de ligne sont normalisées avant l'empreinte : Git peut livrer le
 * même fichier en CRLF sur le poste Windows et en LF sur le VPS. Sans cette
 * normalisation, toute migration paraîtrait modifiée au premier déploiement.
 */
const checksum = (sql) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

/**
 * Lit les fichiers de migration de chaque source.
 *
 * L'ordre est déterministe : le noyau d'abord — ses tables peuvent être
 * référencées — puis les modules par ordre alphabétique, chacun selon la
 * numérotation de ses propres fichiers.
 *
 * @param {{ owner: string, directory: string }[]} sources
 * @returns {{ owner: string, number: number, name: string, file: string, sql: string, checksum: string }[]}
 */
export function readMigrations(sources) {
  const ordered = [...sources].sort(byOwner);
  const migrations = [];

  for (const { owner, directory } of ordered) {
    const seen = new Map();

    for (const entry of listSqlFiles(directory, owner)) {
      const match = FILE_PATTERN.exec(entry);

      if (match === null) {
        // Ignorer un fichier mal nommé serait le pire des traitements : la
        // migration ne s'appliquerait jamais, sans que rien ne le signale.
        throw new MigrationError(
          `nom de fichier de migration non conforme : ${entry}`,
          { owner, file: entry },
        );
      }

      const number = Number(match[1]);

      if (seen.has(number)) {
        throw new MigrationError(
          `deux migrations portent le numéro ${match[1]} pour ${owner}`,
          { owner, number, files: [seen.get(number), entry] },
        );
      }
      seen.set(number, entry);

      const sql = readFileSync(join(directory, entry), 'utf8');

      migrations.push({ owner, number, name: match[2], file: entry, sql, checksum: checksum(sql) });
    }
  }

  return migrations;
}

/** Migrations déjà appliquées, telles que la base les a enregistrées. */
export function readApplied(db) {
  return db.prepare(`SELECT owner, number, name, checksum, applied_at FROM ${TABLE}`).all();
}

/**
 * Compare ce que la base dit avoir appliqué à ce qui se trouve sur le disque.
 *
 * Trois divergences possibles, toutes bloquantes : un fichier disparu, un
 * fichier modifié après coup, et une migration glissée sous un numéro déjà
 * dépassé — ce dernier cas survient quand deux branches créent le même numéro
 * chacune de leur côté.
 *
 * @returns {string[]} anomalies, vide si tout concorde
 */
export function verify(applied, available) {
  const problems = [];
  const onDisk = new Map(available.map((migration) => [key(migration), migration]));

  for (const row of applied) {
    const migration = onDisk.get(key(row));

    if (migration === undefined) {
      problems.push(
        `migration appliquée introuvable sur le disque : ${key(row)} (${row.name}) — ` +
          'fichier supprimé ou renuméroté',
      );
      continue;
    }

    if (migration.checksum !== row.checksum) {
      problems.push(
        `migration modifiée après application : ${key(row)} (${migration.file}) — ` +
          'ne jamais retoucher une migration appliquée, en ajouter une nouvelle',
      );
    } else if (migration.name !== row.name) {
      problems.push(
        `migration renommée après application : ${key(row)}, ${row.name} → ${migration.name}`,
      );
    }
  }

  const highest = new Map();
  for (const row of applied) {
    highest.set(row.owner, Math.max(highest.get(row.owner) ?? -1, row.number));
  }

  const appliedKeys = new Set(applied.map(key));

  for (const migration of available) {
    const limit = highest.get(migration.owner);

    if (limit !== undefined && migration.number < limit && !appliedKeys.has(key(migration))) {
      problems.push(
        `migration ${key(migration)} (${migration.file}) jamais appliquée alors que ` +
          `${migration.owner}/${limit} l'est — numéro inséré après coup, la renuméroter`,
      );
    }
  }

  return problems;
}

/**
 * Applique les migrations en attente.
 *
 * Chaque migration s'exécute dans sa propre transaction, avec l'écriture de sa
 * trace : une migration qui échoue est annulée entièrement et n'apparaît pas
 * comme appliquée. La première défaillance arrête le démarrage — poursuivre
 * laisserait un schéma partiel.
 *
 * @returns {{ applied: string[], total: number }}
 */
export function runMigrations(db, sources, { logger }) {
  ensureTable(db);

  const available = readMigrations(sources);
  const applied = readApplied(db);

  const problems = verify(applied, available);
  if (problems.length > 0) {
    throw new MigrationError(
      `état des migrations incohérent :\n  - ${problems.join('\n  - ')}`,
      { problems },
    );
  }

  const done = new Set(applied.map(key));
  const pending = available.filter((migration) => !done.has(key(migration)));

  const record = db.prepare(
    `INSERT INTO ${TABLE} (owner, number, name, checksum, applied_at) VALUES (?, ?, ?, ?, ?)`,
  );

  for (const migration of pending) {
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      record.run(
        migration.owner,
        migration.number,
        migration.name,
        migration.checksum,
        new Date().toISOString(),
      );
    });

    try {
      apply();
    } catch (cause) {
      throw new MigrationError(
        `migration en échec : ${key(migration)} (${migration.file}) — ${cause.message}`,
        { owner: migration.owner, number: migration.number, file: migration.file },
        cause,
      );
    }

    logger.info('migration appliquée', {
      owner: migration.owner,
      number: migration.number,
      name: migration.name,
    });
  }

  return { applied: pending.map(key), total: available.length };
}

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      owner       TEXT    NOT NULL,
      number      INTEGER NOT NULL,
      name        TEXT    NOT NULL,
      checksum    TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL,
      PRIMARY KEY (owner, number)
    )
  `);
}

/** Les fichiers d'un dossier absent : aucun, ce n'est pas une anomalie. */
function listSqlFiles(directory, owner) {
  let entries;

  try {
    entries = readdirSync(directory);
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];

    throw new MigrationError(
      `dossier de migrations illisible : ${directory}`,
      { owner, directory },
      cause,
    );
  }

  return entries.filter((entry) => entry.toLowerCase().endsWith('.sql')).sort();
}

/** Le noyau passe en premier, les modules ensuite par ordre alphabétique. */
function byOwner(a, b) {
  if (a.owner === b.owner) return 0;
  if (a.owner === CORE_OWNER) return -1;
  if (b.owner === CORE_OWNER) return 1;

  return a.owner.localeCompare(b.owner);
}

const key = ({ owner, number }) => `${owner}/${String(number).padStart(3, '0')}`;
