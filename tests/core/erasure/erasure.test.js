import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createDatabase } from '../../../src/core/database/index.js';
import { ANONYMOUS_USER_ID, createErasureRegistry } from '../../../src/core/erasure/index.js';

const MEMBRE = '123456789012345678';
const AUTRE = '987654321098765432';

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

const sandbox = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cubex-erase-'));
  const logger = fakeLogger();
  const database = createDatabase({ file: join(root, 'test.sqlite'), logger });

  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  database.exec('CREATE TABLE verification_history (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL)');
  database.exec('CREATE TABLE sanctions (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, reason TEXT)');

  const insert = (table, ...users) => {
    const statement = database.prepare(`INSERT INTO ${table} (user_id) VALUES (?)`);
    for (const user of users) statement.run(user);
  };

  const rows = (table) => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all();

  const registry = createErasureRegistry({ database, logger });

  return { database, logger, registry, insert, rows };
};

const DECLARATIONS = [
  { table: 'verification_history', user_column: 'user_id', strategy: 'delete' },
  { table: 'sanctions', user_column: 'user_id', strategy: 'anonymize' },
];

describe('register', () => {
  test('inscrit les déclarations d\'un module', (t) => {
    const { registry } = sandbox(t);

    registry.register('verification', [DECLARATIONS[0]]);
    registry.register('sanctions', [DECLARATIONS[1]]);

    assert.equal(registry.size, 2);
    assert.deepEqual(registry.tables(), [
      'verification/verification_history',
      'sanctions/sanctions',
    ]);
  });

  test('refuse un identifiant SQL qui n\'en est pas un', (t) => {
    const { registry } = sandbox(t);

    for (const table of ['ma table', 'x; DROP TABLE y', '', 42]) {
      assert.throws(
        () => registry.register('x', [{ table, user_column: 'user_id', strategy: 'delete' }]),
        /identifiant SQL/,
      );
    }
  });

  test('refuse une stratégie inconnue', (t) => {
    const { registry } = sandbox(t);

    for (const strategy of ['purge', 'DELETE', undefined, null]) {
      assert.throws(
        () => registry.register('x', [{ table: 't', user_column: 'user_id', strategy }]),
        /strategy attend/,
      );
    }
  });

  test('juge la stratégie avant d\'inspecter la table', (t) => {
    const { registry } = sandbox(t);

    // `t` n'existe pas : sans cet ordre, le refus parlerait de table absente
    // pour une déclaration dont le vrai défaut est ailleurs.
    assert.throws(
      () => registry.register('x', [{ table: 't', user_column: 'user_id', strategy: 'purge' }]),
      /strategy attend/,
    );
  });

  test('porte un code filtrable, comme les autres registres', (t) => {
    const { registry } = sandbox(t);

    try {
      registry.register('x', [{ table: 'absente', user_column: 'user_id', strategy: 'delete' }]);
      assert.fail('la déclaration aurait dû être refusée');
    } catch (error) {
      assert.ok(error instanceof Error, 'les assertions par message continuent de matcher');
      assert.equal(error.code, 'erasure_invalid');
      assert.equal(error.expected, false);
      assert.equal(error.context.owner, 'x');
    }
  });
});

describe('inspection de la table à l\'inscription', () => {
  /** Crée une table de la forme voulue et tente d'y déclarer un effacement. */
  const surTable = (t, ddl, strategy = 'anonymize', column = 'user_id') => {
    const { database, registry } = sandbox(t);

    database.exec(ddl);

    return () => registry.register('sonde', [{ table: 'sonde', user_column: column, strategy }]);
  };

  describe('existence', () => {
    for (const strategy of ['delete', 'anonymize']) {
      test(`table absente refusée en ${strategy}`, (t) => {
        const { registry } = sandbox(t);

        // Aujourd'hui, l'anomalie ne sortirait qu'au premier effacement réel,
        // sous la forme d'un « no such table » qui annule toute la transaction.
        assert.throws(
          () => registry.register('x', [{ table: 'absente', user_column: 'user_id', strategy }]),
          /la table absente n'existe pas/,
        );
      });

      test(`colonne absente refusée en ${strategy}`, (t) => {
        const declarer = surTable(
          t,
          'CREATE TABLE sonde (id INTEGER PRIMARY KEY, autre TEXT)',
          strategy,
        );

        assert.throws(declarer, /la colonne user_id n'existe pas dans sonde/);
      });
    }

    test('trouve la colonne quelle que soit la casse de sa déclaration DDL', (t) => {
      // SQLite rend la colonne avec la casse du DDL, et ses identifiants sont
      // insensibles à la casse : une comparaison stricte refuserait une table
      // sur laquelle le SQL fonctionne parfaitement.
      const declarer = surTable(t, 'CREATE TABLE sonde (id INTEGER PRIMARY KEY, User_Id TEXT)');

      assert.doesNotThrow(declarer);
    });
  });

  describe('anonymize refusé sur une colonne unique', () => {
    const CAS = [
      ['clé primaire simple', 'CREATE TABLE sonde (user_id TEXT PRIMARY KEY)', /la clé primaire/],
      [
        'INTEGER PRIMARY KEY, alias de rowid',
        'CREATE TABLE sonde (user_id INTEGER PRIMARY KEY)',
        /la clé primaire/,
      ],
      [
        'clé primaire composite',
        'CREATE TABLE sonde (user_id TEXT, guild_id TEXT, PRIMARY KEY (user_id, guild_id))',
        /clé primaire composite \(user_id, guild_id\)/,
      ],
      [
        'contrainte UNIQUE de colonne',
        'CREATE TABLE sonde (id INTEGER PRIMARY KEY, user_id TEXT UNIQUE)',
        /une contrainte UNIQUE/,
      ],
      [
        'contrainte UNIQUE composite',
        'CREATE TABLE sonde (id INTEGER PRIMARY KEY, autre TEXT, user_id TEXT, UNIQUE (autre, user_id))',
        /contrainte UNIQUE composite \(autre, user_id\)/,
      ],
      [
        'index unique explicite',
        'CREATE TABLE sonde (id INTEGER PRIMARY KEY, user_id TEXT); CREATE UNIQUE INDEX ix ON sonde(user_id)',
        /l'index unique « ix »/,
      ],
      [
        'index unique partiel',
        'CREATE TABLE sonde (id INTEGER PRIMARY KEY, user_id TEXT, actif INT); ' +
          'CREATE UNIQUE INDEX ix ON sonde(user_id) WHERE actif = 1',
        /partielle/,
      ],
      [
        'WITHOUT ROWID, clé simple',
        'CREATE TABLE sonde (user_id TEXT PRIMARY KEY, x TEXT) WITHOUT ROWID',
        /la clé primaire/,
      ],
      [
        'WITHOUT ROWID, clé composite',
        'CREATE TABLE sonde (user_id TEXT, guild_id TEXT, PRIMARY KEY (user_id, guild_id)) WITHOUT ROWID',
        /clé primaire composite/,
      ],
    ];

    for (const [nom, ddl, motif] of CAS) {
      test(nom, (t) => {
        const declarer = surTable(t, ddl);

        // Le deuxième effacement heurterait la ligne déjà anonymisée et
        // annulerait toute la transaction, tables des autres modules comprises.
        assert.throws(declarer, /anonymize est impossible/);
        assert.throws(declarer, motif);
        assert.throws(declarer, /strategy « delete »/);
      });
    }
  });

  describe('anonymize accepté quand rien ne contraint la colonne', () => {
    test('colonne libre', (t) => {
      assert.doesNotThrow(
        surTable(t, 'CREATE TABLE sonde (id INTEGER PRIMARY KEY, user_id TEXT NOT NULL)'),
      );
    });

    test('index NON unique', (t) => {
      assert.doesNotThrow(
        surTable(
          t,
          'CREATE TABLE sonde (id INTEGER PRIMARY KEY, user_id TEXT); CREATE INDEX ix ON sonde(user_id)',
        ),
      );
    });

    test('contrainte unique portant sur une AUTRE colonne', (t) => {
      assert.doesNotThrow(
        surTable(t, 'CREATE TABLE sonde (id INTEGER PRIMARY KEY, user_id TEXT, autre TEXT UNIQUE)'),
      );
    });

    test('WITHOUT ROWID : une colonne hors clé reste libre', (t) => {
      // Le piège d'index_xinfo, qui rend aussi les colonnes NON clés : les
      // prendre pour des membres de la contrainte refuserait une table saine.
      assert.doesNotThrow(
        surTable(
          t,
          'CREATE TABLE sonde (cle TEXT PRIMARY KEY, user_id TEXT) WITHOUT ROWID',
        ),
      );
    });
  });

  describe('delete n\'a pas ce problème', () => {
    for (const [nom, ddl] of [
      ['clé primaire', 'CREATE TABLE sonde (user_id TEXT PRIMARY KEY)'],
      ['contrainte UNIQUE', 'CREATE TABLE sonde (id INTEGER PRIMARY KEY, user_id TEXT UNIQUE)'],
    ]) {
      test(nom, (t) => {
        // Supprimer une ligne ne heurte aucune contrainte d'unicité.
        assert.doesNotThrow(surTable(t, ddl, 'delete'));
      });
    }
  });
});

describe('erase', () => {
  const inscrire = (registry) => {
    registry.register('verification', [DECLARATIONS[0]]);
    registry.register('sanctions', [DECLARATIONS[1]]);
  };

  test('supprime ce qui doit disparaître et anonymise ce qui survit', (t) => {
    const { registry, insert, rows } = sandbox(t);
    inscrire(registry);

    insert('verification_history', MEMBRE, MEMBRE, AUTRE);
    insert('sanctions', MEMBRE, AUTRE);

    const report = registry.erase(MEMBRE);

    assert.deepEqual(report, [
      { owner: 'verification', table: 'verification_history', strategy: 'delete', affected: 2 },
      { owner: 'sanctions', table: 'sanctions', strategy: 'anonymize', affected: 1 },
    ]);

    // L'historique de vérification disparaît.
    assert.deepEqual(rows('verification_history').map((row) => row.user_id), [AUTRE]);

    // La sanction subsiste sans son porteur : la supprimer viderait la mémoire
    // de modération, que la purge conserve précisément sans limite.
    assert.deepEqual(rows('sanctions').map((row) => row.user_id), [ANONYMOUS_USER_ID, AUTRE]);
  });

  test('l\'identifiant de remplacement ne peut être confondu avec un membre', () => {
    // 17 à 20 chiffres pour un identifiant Discord : « 0 » n'en est jamais un.
    assert.equal(/^\d{17,20}$/.test(ANONYMOUS_USER_ID), false);
  });

  test('ne touche pas aux autres membres', (t) => {
    const { registry, insert, rows } = sandbox(t);
    inscrire(registry);

    insert('verification_history', AUTRE);
    insert('sanctions', AUTRE);

    registry.erase(MEMBRE);

    assert.equal(rows('verification_history')[0].user_id, AUTRE);
    assert.equal(rows('sanctions')[0].user_id, AUTRE);
  });

  test('annule tout quand une table échoue', (t) => {
    const { database, registry, insert, rows, logger } = sandbox(t);

    registry.register('verification', [DECLARATIONS[0]]);
    registry.register('sanctions', [DECLARATIONS[1]]);

    insert('verification_history', MEMBRE);

    // La table disparaît APRÈS l'inscription : le registre refuse désormais une
    // table absente au moment de déclarer, et une migration qui retire une
    // table est de toute façon plus proche du réel que la déclaration d'une
    // table qui n'a jamais existé.
    database.exec('DROP TABLE sanctions');

    // Contrairement à la purge, un effacement partiel est un effacement raté :
    // le signaler comme réussi laisserait des données que le membre croit
    // supprimées.
    assert.throws(() => registry.erase(MEMBRE));

    assert.equal(rows('verification_history').length, 1, 'la transaction est annulée');
    assert.match(logger.of('error')[0].message, /aucune table modifiée/);
  });

  test('journalise le compte rendu par table', (t) => {
    const { registry, logger, insert } = sandbox(t);
    inscrire(registry);
    insert('verification_history', MEMBRE);
    insert('sanctions', MEMBRE);

    registry.erase(MEMBRE);

    const compte = logger.of('info').at(-1);
    assert.match(compte.message, /effacement exécuté/);
    assert.equal(compte.context.affected, 2);
    assert.equal(compte.context.tables.length, 2);
  });

  test('reste sans effet sur un membre inconnu', (t) => {
    const { registry, insert, rows } = sandbox(t);
    inscrire(registry);
    insert('sanctions', AUTRE);

    const report = registry.erase(MEMBRE);

    assert.deepEqual(report.map((line) => line.affected), [0, 0]);
    assert.equal(rows('sanctions')[0].user_id, AUTRE);
  });
});

describe('preview', () => {
  test('compte sans rien modifier', (t) => {
    const { registry, insert, rows } = sandbox(t);
    registry.register('verification', [DECLARATIONS[0]]);
    registry.register('sanctions', [DECLARATIONS[1]]);

    insert('verification_history', MEMBRE, MEMBRE);
    insert('sanctions', MEMBRE);

    const aperçu = registry.preview(MEMBRE);

    assert.deepEqual(aperçu.map((line) => line.rows), [2, 1]);
    assert.equal(aperçu[1].strategy, 'anonymize');

    // Un effacement ne se défait pas : l'aperçu doit pouvoir précéder la
    // confirmation sans rien engager.
    assert.equal(rows('verification_history').length, 2);
    assert.equal(rows('sanctions')[0].user_id, MEMBRE);
  });
});
