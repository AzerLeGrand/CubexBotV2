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
    const { registry, insert, rows, logger } = sandbox(t);

    registry.register('verification', [DECLARATIONS[0]]);
    registry.register('fantome', [
      { table: 'table_absente', user_column: 'user_id', strategy: 'delete' },
    ]);

    insert('verification_history', MEMBRE);

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
