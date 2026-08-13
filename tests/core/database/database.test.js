import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { createDatabase, MigrationError } from '../../../src/core/database/index.js';
import { readMigrations, verify } from '../../../src/core/database/migrations.js';
import { tempDir } from '../../helpers/fixtures.js';

/** Journal factice : retient les entrées au lieu de les écrire. */
const fakeLogger = () => {
  const entries = [];
  const record = (level) => (message, context) => entries.push({ level, message, context });

  return {
    entries,
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    of: (level) => entries.filter((entry) => entry.level === level),
  };
};

/** Dossier de migrations peuplé des fichiers donnés. */
const migrationsDir = (root, owner, files) => {
  const directory = join(root, owner);
  mkdirSync(directory, { recursive: true });

  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(directory, name), sql, 'utf8');
  }

  return { owner, directory };
};

/**
 * Dossier temporaire dont la suppression attend la fermeture des bases.
 *
 * `tempDir` ne convient pas ici : les hooks `after` s'exécutent dans l'ordre
 * d'enregistrement, donc le dossier partirait avant que la base ne soit
 * fermée — et Windows refuse de supprimer un fichier encore ouvert.
 */
const sandbox = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cubex-db-'));
  const opened = [];
  const logger = fakeLogger();

  t.after(() => {
    for (const database of opened) database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const open = (options = {}) => {
    const database = createDatabase({
      file: join(root, 'data', 'test.sqlite'),
      logger,
      ...options,
    });

    opened.push(database);

    return database;
  };

  return { root, logger, open };
};

const TABLE_A = 'CREATE TABLE alpha (id INTEGER PRIMARY KEY, label TEXT NOT NULL);';
const TABLE_B = 'CREATE TABLE beta (id INTEGER PRIMARY KEY, alpha_id INTEGER REFERENCES alpha(id));';

describe('ouverture', () => {
  test('crée le dossier et le fichier', (t) => {
    const database = sandbox(t).open();

    assert.ok(database.path.endsWith('test.sqlite'));
    assert.equal(database.raw.open, true);
  });

  test('active le mode WAL et les clés étrangères', (t) => {
    const database = sandbox(t).open();

    assert.equal(database.raw.pragma('journal_mode', { simple: true }), 'wal');
    assert.equal(database.raw.pragma('foreign_keys', { simple: true }), 1);
  });

  test('fait respecter les clés étrangères', (t) => {
    const database = sandbox(t).open();

    database.exec(TABLE_A);
    database.exec(TABLE_B);

    // Sans le pragma, cette insertion passerait sans broncher : SQLite accepte
    // les contraintes dans le schéma mais ne les applique pas par défaut.
    assert.throws(
      () => database.prepare('INSERT INTO beta (alpha_id) VALUES (99)').run(),
      /FOREIGN KEY/,
    );
  });

  test('résout un chemin relatif depuis la racine du projet, pas depuis le cwd', (t) => {
    const database = createDatabase({ file: 'data/relatif-test.sqlite', logger: fakeLogger() });

    t.after(() => {
      database.close();
      for (const suffixe of ['', '-wal', '-shm']) {
        rmSync(`${database.path}${suffixe}`, { force: true });
      }
    });

    assert.equal(isAbsolute(database.path), true);
    assert.ok(database.path.endsWith(join('data', 'relatif-test.sqlite')));
  });
});

describe('fermeture', () => {
  test('exécute un checkpoint puis ferme', (t) => {
    const { open, logger } = sandbox(t);
    const database = open();

    database.exec(TABLE_A);
    database.close();

    assert.equal(database.raw.open, false);
    assert.match(logger.of('info').at(-1).message, /fermée/);
  });

  test('supporte un second appel', (t) => {
    const database = sandbox(t).open();

    database.close();
    assert.doesNotThrow(() => database.close());
  });

  test('s\'inscrit dans la séquence d\'arrêt quand elle est fournie', (t) => {
    const inscrites = [];
    const shutdown = { register: (name, close) => inscrites.push({ name, close }) };

    const database = sandbox(t).open({ shutdown });

    assert.deepEqual(inscrites.map((entry) => entry.name), ['database']);

    inscrites[0].close();
    assert.equal(database.raw.open, false);
  });
});

describe('migrations — application', () => {
  test('applique dans l\'ordre et renseigne la table de suivi', (t) => {
    const { open, logger, root } = sandbox(t);
    const database = open();
    const source = migrationsDir(root, 'core', { '001_alpha.sql': TABLE_A, '002_beta.sql': TABLE_B });

    const result = database.migrate([source]);

    assert.deepEqual(result.applied, ['core/001', 'core/002']);
    assert.equal(result.total, 2);

    const rows = database.prepare('SELECT * FROM schema_migrations ORDER BY number').all();
    assert.deepEqual(rows.map((row) => [row.owner, row.number, row.name]), [
      ['core', 1, 'alpha'],
      ['core', 2, 'beta'],
    ]);
    assert.match(rows[0].applied_at, /^\d{4}-\d{2}-\d{2}T.+Z$/);
    assert.match(rows[0].checksum, /^[0-9a-f]{64}$/);

    assert.equal(logger.of('info').filter((e) => e.message === 'migration appliquée').length, 2);
  });

  test('n\'applique rien au second démarrage', (t) => {
    const { open, root } = sandbox(t);
    const database = open();
    const source = migrationsDir(root, 'core', { '001_alpha.sql': TABLE_A });

    database.migrate([source]);
    const second = database.migrate([source]);

    assert.deepEqual(second.applied, []);
    assert.equal(second.total, 1);
  });

  test('un dossier absent ne produit aucune migration ni erreur', (t) => {
    const { open, root } = sandbox(t);

    const result = open().migrate([{ owner: 'core', directory: join(root, 'inexistant') }]);

    assert.deepEqual(result.applied, []);
  });

  test('applique le noyau avant les modules, puis les modules par ordre alphabétique', (t) => {
    const { open, root } = sandbox(t);
    const database = open();

    const sources = [
      migrationsDir(root, 'tickets', { '001_t.sql': 'CREATE TABLE t (id INTEGER);' }),
      migrationsDir(root, 'appeals', { '001_a.sql': 'CREATE TABLE a (id INTEGER);' }),
      migrationsDir(root, 'core', { '001_c.sql': 'CREATE TABLE c (id INTEGER);' }),
    ];

    assert.deepEqual(database.migrate(sources).applied, [
      'core/001',
      'appeals/001',
      'tickets/001',
    ]);
  });

  test('deux modules peuvent porter le même numéro', (t) => {
    const { open, root } = sandbox(t);
    const database = open();

    const sources = [
      migrationsDir(root, 'core', { '001_c.sql': 'CREATE TABLE c (id INTEGER);' }),
      migrationsDir(root, 'tickets', { '001_t.sql': 'CREATE TABLE t (id INTEGER);' }),
    ];

    assert.deepEqual(database.migrate(sources).applied, ['core/001', 'tickets/001']);
  });
});

describe('migrations — échecs', () => {
  test('annule entièrement une migration en échec', (t) => {
    const { open, root } = sandbox(t);
    const database = open();
    const source = migrationsDir(root, 'core', {
      // La première instruction passe, la seconde échoue : la transaction doit
      // emporter les deux.
      '001_cassee.sql': `${TABLE_A}\nCREATE TABLE alpha (id INTEGER);`,
    });

    assert.throws(() => database.migrate([source]), MigrationError);

    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'alpha'")
      .all();

    assert.deepEqual(tables, [], 'la table créée avant l\'échec doit avoir disparu');
    assert.deepEqual(database.prepare('SELECT * FROM schema_migrations').all(), []);
  });

  test('arrête la série à la première défaillance', (t) => {
    const { open, root } = sandbox(t);
    const database = open();
    const source = migrationsDir(root, 'core', {
      '001_alpha.sql': TABLE_A,
      '002_cassee.sql': 'CECI N EST PAS DU SQL;',
      '003_jamais.sql': 'CREATE TABLE jamais (id INTEGER);',
    });

    assert.throws(() => database.migrate([source]), /002_cassee/);

    const rows = database.prepare('SELECT number FROM schema_migrations').all();
    assert.deepEqual(rows, [{ number: 1 }], 'seule la première est enregistrée');
  });

  test('refuse un fichier .sql au nom non conforme', (t) => {
    const { open, root } = sandbox(t);
    const source = migrationsDir(root, 'core', { 'ajout-table.sql': TABLE_A });

    assert.throws(() => open().migrate([source]), /non conforme/);
  });

  test('refuse deux migrations de même numéro pour un même propriétaire', (t) => {
    const { open, root } = sandbox(t);
    const database = open();
    const source = migrationsDir(root, 'core', {
      '001_alpha.sql': TABLE_A,
      '001_autre.sql': 'CREATE TABLE autre (id INTEGER);',
    });

    assert.throws(() => database.migrate([source]), /portent le numéro 001/);
  });
});

describe('migrations — intégrité', () => {
  const CORE = ['core'];

  const applied = (over = {}) => [
    { owner: 'core', number: 1, name: 'alpha', checksum: 'aaa', applied_at: 'x', ...over },
  ];

  const onDisk = (over = {}) => [
    { owner: 'core', number: 1, name: 'alpha', file: '001_alpha.sql', checksum: 'aaa', ...over },
  ];

  test('ne signale rien quand tout concorde', () => {
    assert.deepEqual(verify(applied(), onDisk(), CORE), { problems: [], retired: [] });
  });

  test('détecte une migration modifiée après application', () => {
    const [problem] = verify(applied(), onDisk({ checksum: 'bbb' }), CORE).problems;

    assert.match(problem, /modifiée après application/);
    assert.match(problem, /en ajouter une nouvelle/);
  });

  test('détecte une migration disparue du disque', () => {
    const [problem] = verify(applied(), [], CORE).problems;

    assert.match(problem, /introuvable sur le disque/);
    assert.match(problem, /supprimé ou renuméroté/);
  });

  test('détecte une migration renommée', () => {
    const [problem] = verify(applied(), onDisk({ name: 'autrement' }), CORE).problems;

    assert.match(problem, /renommée/);
  });

  test('détecte un numéro inséré sous un numéro déjà appliqué', () => {
    // Deux branches créent chacune leur 002 ; l'une est appliquée, l'autre
    // arrive plus tard et ne s'appliquerait jamais.
    const rows = [
      ...applied(),
      { owner: 'core', number: 3, name: 'gamma', checksum: 'ccc', applied_at: 'x' },
    ];
    const files = [
      ...onDisk(),
      { owner: 'core', number: 2, name: 'beta', file: '002_beta.sql', checksum: 'bbb' },
      { owner: 'core', number: 3, name: 'gamma', file: '003_gamma.sql', checksum: 'ccc' },
    ];

    const [problem] = verify(rows, files, CORE).problems;

    assert.match(problem, /core\/002/);
    assert.match(problem, /inséré après coup/);
  });

  test('accepte une migration nouvelle au-delà du dernier numéro appliqué', () => {
    const files = [
      ...onDisk(),
      { owner: 'core', number: 2, name: 'beta', file: '002_beta.sql', checksum: 'bbb' },
    ];

    assert.deepEqual(verify(applied(), files, CORE).problems, []);
  });

  test('un propriétaire sans source est retiré, pas manquant', () => {
    // tickets a été sorti du dépôt : ses migrations restent en base, mais
    // aucune source n'est fournie pour lui.
    const rows = [
      ...applied(),
      { owner: 'tickets', number: 1, name: 't', checksum: 'ttt', applied_at: 'x' },
      { owner: 'tickets', number: 2, name: 'u', checksum: 'uuu', applied_at: 'x' },
    ];

    const { problems, retired } = verify(rows, onDisk(), CORE);

    assert.deepEqual(problems, [], 'retirer un module ne doit pas bloquer le démarrage');
    assert.deepEqual(retired, [{ owner: 'tickets', count: 2 }]);
  });

  test('un propriétaire présent dont le fichier manque reste bloquant', () => {
    // La distinction porte sur le propriétaire, pas sur le fichier seul : ici
    // tickets est bien là, c'est sa migration qui a disparu.
    const rows = [{ owner: 'tickets', number: 1, name: 't', checksum: 'ttt', applied_at: 'x' }];

    const { problems, retired } = verify(rows, [], ['core', 'tickets']);

    assert.equal(problems.length, 1);
    assert.match(problems[0], /introuvable sur le disque/);
    assert.deepEqual(retired, []);
  });

  test('journalise le module retiré sans interrompre les autres migrations', (t) => {
    const { open, root, logger } = sandbox(t);
    const database = open();

    const tickets = migrationsDir(root, 'tickets', { '001_t.sql': 'CREATE TABLE t (id INTEGER);' });
    const core = migrationsDir(root, 'core', { '001_alpha.sql': TABLE_A });

    database.migrate([core, tickets]);

    // tickets disparaît du dépôt : seule la source du noyau est fournie.
    const result = database.migrate([core]);

    assert.deepEqual(result.retired, [{ owner: 'tickets', count: 1 }]);

    const avertissement = logger.of('warn').at(-1);
    assert.match(avertissement.message, /module absent/);
    assert.equal(avertissement.context.owner, 'tickets');
    assert.match(avertissement.context.hint, /décision manuelle/);

    // La table du module retiré est toujours là.
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 't'")
      .all();
    assert.equal(tables.length, 1, 'les données d\'un module retiré ne disparaissent pas');
  });

  test('réapplique sans heurt quand le module revient', (t) => {
    const { open, root } = sandbox(t);
    const database = open();

    const tickets = migrationsDir(root, 'tickets', { '001_t.sql': 'CREATE TABLE t (id INTEGER);' });
    const core = migrationsDir(root, 'core', { '001_alpha.sql': TABLE_A });

    database.migrate([core, tickets]);
    database.migrate([core]);

    const retour = database.migrate([core, tickets]);

    assert.deepEqual(retour.applied, [], 'rien à réappliquer, les empreintes concordent');
    assert.deepEqual(retour.retired, []);
  });

  test('refuse de démarrer sur une divergence, sans rien appliquer', (t) => {
    const { open, root } = sandbox(t);
    const database = open();
    const directory = join(root, 'core');
    const source = migrationsDir(root, 'core', { '001_alpha.sql': TABLE_A });

    database.migrate([source]);

    // Quelqu'un retouche un fichier déjà appliqué.
    writeFileSync(join(directory, '001_alpha.sql'), `${TABLE_A}\n-- ajout tardif`, 'utf8');

    assert.throws(() => database.migrate([source]), /modifiée après application/);
  });
});

describe('empreintes', () => {
  test('ignore la différence entre CRLF et LF', (t) => {
    const root = tempDir(t);
    const lf = migrationsDir(root, 'lf', { '001_alpha.sql': 'CREATE TABLE a (id INTEGER);\n' });
    const crlf = migrationsDir(root, 'crlf', { '001_alpha.sql': 'CREATE TABLE a (id INTEGER);\r\n' });

    const [avecLf] = readMigrations([lf]);
    const [avecCrlf] = readMigrations([crlf]);

    // Sans normalisation, toute migration paraîtrait modifiée au premier
    // déploiement depuis un poste Windows.
    assert.equal(avecLf.checksum, avecCrlf.checksum);
  });
});

describe('dossier migrations/ livré', () => {
  test('est lisible et n\'apporte aucune migration en phase 0', (t) => {
    // fileURLToPath, pas URL.pathname : sur Windows ce dernier rend « /D:/… »,
    // que readdirSync refuse.
    const directory = fileURLToPath(new URL('../../../migrations/', import.meta.url));

    const result = sandbox(t).open().migrate([{ owner: 'core', directory }]);

    assert.deepEqual(result.applied, [], 'le README ne doit pas être pris pour une migration');
  });
});
