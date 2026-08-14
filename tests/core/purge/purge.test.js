import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createDatabase } from '../../../src/core/database/index.js';
import { createPurgeRegistry, msUntilNextRun } from '../../../src/core/purge/index.js';

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

const RETENTIONS = {
  'logs.retention.message_content_days': 30,
  'logs.retention.structural_days': 90,
  'purge.hour': 4,
  'bot.timezone': 'Europe/Paris',
};

const fakeConfig = {
  get: (path) => {
    if (!(path in RETENTIONS)) throw new Error(`chemin de configuration inconnu : ${path}`);
    return RETENTIONS[path];
  },
};

const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

/** Base réelle : la purge est du SQL, la simuler ne prouverait rien. */
const sandbox = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cubex-purge-'));
  const logger = fakeLogger();
  const database = createDatabase({ file: join(root, 'test.sqlite'), logger });

  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  database.exec('CREATE TABLE log_events (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL)');
  database.exec('CREATE TABLE log_contents (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL)');

  const insert = (table, ...dates) => {
    const statement = database.prepare(`INSERT INTO ${table} (created_at) VALUES (?)`);
    for (const date of dates) statement.run(date);
  };

  const count = (table) =>
    database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

  const registry = createPurgeRegistry({ database, config: fakeConfig, logger });

  return { database, logger, registry, insert, count };
};

describe('register', () => {
  test('inscrit les déclarations d\'un module', (t) => {
    const { registry } = sandbox(t);

    registry.register('logs', [
      { table: 'log_events', date_column: 'created_at', retention_key: 'logs.retention.structural_days' },
      { table: 'log_contents', date_column: 'created_at', retention_key: 'logs.retention.message_content_days' },
    ]);

    assert.equal(registry.size, 2);
  });

  test('refuse un identifiant SQL qui n\'en est pas un', (t) => {
    const { registry } = sandbox(t);

    // Table et colonne sont interpolées : SQLite ne les accepte pas en
    // paramètre lié. La porte se ferme ici plutôt que de compter sur l'appelant.
    for (const table of ['log events', 'log-events', 'logs; DROP TABLE users', '', 42]) {
      assert.throws(
        () => registry.register('x', [{ table, date_column: 'created_at', retention_key: 'k' }]),
        /identifiant SQL/,
      );
    }
  });

  test('refuse une date_column mal formée et une clé de rétention absente', (t) => {
    const { registry } = sandbox(t);

    assert.throws(
      () => registry.register('x', [{ table: 't', date_column: 'a b', retention_key: 'k' }]),
      /identifiant SQL/,
    );
    assert.throws(
      () => registry.register('x', [{ table: 't', date_column: 'created_at' }]),
      /retention_key/,
    );
  });

  test('juge les identifiants et la clé avant d\'inspecter la table', (t) => {
    const { registry } = sandbox(t);

    // `t` n'existe pas : sans cet ordre, le refus parlerait de table absente
    // pour une déclaration dont le vrai défaut est ailleurs.
    assert.throws(
      () => registry.register('x', [{ table: 't', date_column: 'created_at' }]),
      /retention_key/,
    );
  });

  test('refuse une table ou une colonne inexistante', (t) => {
    const { registry } = sandbox(t);

    // Symétrique du registre d'effacement. Sans ce contrôle, une faute de
    // frappe ne se manifesterait que par une ligne de journal à 4 h du matin,
    // et une table jamais purgée passerait des mois inaperçue.
    assert.throws(
      () =>
        registry.register('logs', [
          { table: 'absente', date_column: 'created_at', retention_key: 'logs.retention.structural_days' },
        ]),
      /la table absente n'existe pas/,
    );

    assert.throws(
      () =>
        registry.register('logs', [
          { table: 'log_events', date_column: 'cree_le', retention_key: 'logs.retention.structural_days' },
        ]),
      /la colonne cree_le n'existe pas dans log_events/,
    );
  });

  test('porte un code filtrable, comme les autres registres', (t) => {
    const { registry } = sandbox(t);

    try {
      registry.register('logs', [
        { table: 'absente', date_column: 'created_at', retention_key: 'logs.retention.structural_days' },
      ]);
      assert.fail('la déclaration aurait dû être refusée');
    } catch (error) {
      assert.ok(error instanceof Error, 'les assertions par message continuent de matcher');
      assert.equal(error.code, 'purge_invalid');
      assert.equal(error.expected, false);
      assert.equal(error.context.owner, 'logs');
    }
  });
});

describe('run', () => {
  const inscrire = (registry) =>
    registry.register('logs', [
      { table: 'log_events', date_column: 'created_at', retention_key: 'logs.retention.structural_days' },
      { table: 'log_contents', date_column: 'created_at', retention_key: 'logs.retention.message_content_days' },
    ]);

  test('supprime au-delà de la rétention et conserve en deçà', (t) => {
    const { registry, insert, count } = sandbox(t);
    inscrire(registry);

    insert('log_events', daysAgo(100), daysAgo(91), daysAgo(89), daysAgo(1));
    insert('log_contents', daysAgo(40), daysAgo(31), daysAgo(29));

    const report = registry.run();

    assert.equal(count('log_events'), 2);
    assert.equal(count('log_contents'), 1);
    assert.deepEqual(report, [
      { owner: 'logs', table: 'log_events', deleted: 2 },
      { owner: 'logs', table: 'log_contents', deleted: 2 },
    ]);
  });

  test('applique une durée différente par table', (t) => {
    const { registry, insert, count } = sandbox(t);
    inscrire(registry);

    // 60 jours : au-delà de la rétention des contenus (30), en deçà de celle
    // des métadonnées (90). C'est ce que le socle §10 demande.
    insert('log_events', daysAgo(60));
    insert('log_contents', daysAgo(60));

    registry.run();

    assert.equal(count('log_events'), 1);
    assert.equal(count('log_contents'), 0);
  });

  test('une erreur sur une table n\'interrompt pas les autres', (t) => {
    const { database, registry, logger, insert, count } = sandbox(t);

    database.exec('CREATE TABLE log_fantome (id INTEGER PRIMARY KEY, created_at TEXT NOT NULL)');

    registry.register('fantome', [
      { table: 'log_fantome', date_column: 'created_at', retention_key: 'logs.retention.structural_days' },
    ]);
    inscrire(registry);

    // La table disparaît APRÈS l'inscription : le registre refuse désormais une
    // table absente au moment de déclarer. Une table retirée par une migration
    // ultérieure est de toute façon plus proche du réel.
    database.exec('DROP TABLE log_fantome');

    insert('log_events', daysAgo(100));

    const report = registry.run();

    assert.match(report[0].error, /log_fantome/);
    assert.equal(report[1].deleted, 1, 'la table suivante a bien été traitée');
    assert.equal(count('log_events'), 0);
    assert.match(logger.of('error')[0].message, /purge impossible/);
  });

  test('signale une clé de rétention inconnue sans bloquer le reste', (t) => {
    const { registry, insert, count } = sandbox(t);

    registry.register('casse', [
      { table: 'log_events', date_column: 'created_at', retention_key: 'inexistante.cle' },
    ]);
    registry.register('logs', [
      { table: 'log_contents', date_column: 'created_at', retention_key: 'logs.retention.message_content_days' },
    ]);

    insert('log_events', daysAgo(100));
    insert('log_contents', daysAgo(100));

    const report = registry.run();

    assert.match(report[0].error, /inexistante\.cle/);
    assert.equal(count('log_events'), 1, 'rien n\'est supprimé sans durée connue');
    assert.equal(count('log_contents'), 0);
  });

  test('rend un compte rendu par table', (t) => {
    const { registry, logger, insert } = sandbox(t);
    inscrire(registry);
    insert('log_events', daysAgo(100), daysAgo(100));

    registry.run();

    const compte = logger.of('info').at(-1);
    assert.match(compte.message, /purge quotidienne/);
    assert.equal(compte.context.deleted, 2);
    assert.equal(compte.context.failed, 0);
    assert.equal(compte.context.tables.length, 2);
  });

  test('ne fait rien quand aucun module ne déclare', (t) => {
    const { registry } = sandbox(t);

    assert.deepEqual(registry.run(), []);
  });
});

describe('format de date_column', () => {
  const inscrire = (registry, table = 'log_events') =>
    registry.register('logs', [
      { table, date_column: 'created_at', retention_key: 'logs.retention.structural_days' },
    ]);

  test('refuse de purger une colonne stockée en entier Unix', (t) => {
    const { registry, logger, database, count } = sandbox(t);
    inscrire(registry);

    // SQLite classe NULL < INTEGER < TEXT : sans ce contrôle,
    // `created_at < cutoff` serait TOUJOURS vrai et viderait la table entière.
    const secondes = Math.floor(Date.now() / 1000);
    database.prepare('INSERT INTO log_events (created_at) VALUES (?)').run(secondes);

    const [ligne] = registry.run();

    assert.match(ligne.error, /ISO 8601 en TEXT/);
    assert.match(ligne.error, /viderait la table entière/);
    assert.equal(count('log_events'), 1, 'la ligne d\'aujourd\'hui ne doit pas disparaître');
    assert.match(logger.of('error')[0].message, /purge impossible/);
  });

  test('refuse le séparateur espace de datetime(\'now\')', (t) => {
    const { registry, database, count } = sandbox(t);
    inscrire(registry);

    // `2026-08-13 04:00:00` est du TEXT, donc la comparaison ne déraille pas
    // sur les types — mais l'espace (0x20) précède le T (0x54), et toutes les
    // lignes du jour passeraient pour antérieures au seuil.
    database.prepare("INSERT INTO log_events (created_at) VALUES (datetime('now'))").run();

    const [ligne] = registry.run();

    assert.match(ligne.error, /séparateur en position 10 : " "/);
    assert.equal(count('log_events'), 1);
  });

  test('ne cite jamais la valeur lue', (t) => {
    const { registry, database } = sandbox(t);
    inscrire(registry);

    // Si date_column désigne la mauvaise colonne, ce serait du contenu de
    // message qui partirait au journal.
    const secret = 'contenu-de-message-tres-prive';
    database.prepare('INSERT INTO log_events (created_at) VALUES (?)').run(secret);

    const [ligne] = registry.run();

    assert.ok(!ligne.error.includes(secret));
  });

  test('reporte le contrôle sur une table vide, sans erreur', (t) => {
    const { registry } = sandbox(t);
    inscrire(registry);

    const [ligne] = registry.run();

    assert.equal(ligne.error, undefined);
    assert.equal(ligne.deleted, 0);
    assert.equal(ligne.deferred, true);
  });

  test('purge normalement dès que la table porte un horodatage valide', (t) => {
    const { registry, insert, count } = sandbox(t);
    inscrire(registry);

    registry.run(); // table vide : contrôle reporté

    insert('log_events', daysAgo(100), daysAgo(1));
    const [ligne] = registry.run();

    assert.equal(ligne.deleted, 1);
    assert.equal(count('log_events'), 1);
  });

  test('ne contrôle qu\'une fois par table', (t) => {
    const { registry, insert, database } = sandbox(t);
    inscrire(registry);
    insert('log_events', daysAgo(1));

    registry.run();

    // Une valeur invalide insérée après le contrôle n'est plus relue : le
    // contrôle porte sur le schéma, pas sur chaque ligne.
    database.prepare('INSERT INTO log_events (created_at) VALUES (?)').run(42);

    assert.equal(registry.run()[0].error, undefined);
  });

  test('une table au mauvais format n\'empêche pas les autres', (t) => {
    const { registry, database, insert, count } = sandbox(t);

    registry.register('logs', [
      { table: 'log_events', date_column: 'created_at', retention_key: 'logs.retention.structural_days' },
      { table: 'log_contents', date_column: 'created_at', retention_key: 'logs.retention.message_content_days' },
    ]);

    database.prepare('INSERT INTO log_events (created_at) VALUES (?)').run(1_700_000_000);
    insert('log_contents', daysAgo(100));

    const report = registry.run();

    assert.match(report[0].error, /ISO 8601/);
    assert.equal(report[1].deleted, 1);
    assert.equal(count('log_events'), 1);
    assert.equal(count('log_contents'), 0);
  });
});

describe('planification', () => {
  test('s\'inscrit dans la séquence d\'arrêt', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'cubex-purge-'));
    const logger = fakeLogger();
    const database = createDatabase({ file: join(root, 'test.sqlite'), logger });
    const inscrites = [];

    t.after(() => {
      database.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    createPurgeRegistry({
      database,
      config: fakeConfig,
      logger,
      shutdown: { register: (name, close) => inscrites.push({ name, close }) },
    });

    assert.deepEqual(inscrites.map((entry) => entry.name), ['purge']);
  });

  test('arme puis désarme la minuterie', (t) => {
    const { registry, logger } = sandbox(t);

    registry.start();

    const planifiée = logger.of('info').at(-1);
    assert.match(planifiée.message, /purge planifiée/);
    assert.equal(planifiée.context.hour, 4);
    assert.equal(planifiée.context.timezone, 'Europe/Paris');

    assert.doesNotThrow(() => registry.stop());
    assert.doesNotThrow(() => registry.stop());
  });
});

describe('msUntilNextRun', () => {
  const at = (iso) => new Date(iso);

  test('vise la prochaine occurrence dans la journée', () => {
    // 01h00 heure de Paris en été = 23h00 UTC la veille.
    const delay = msUntilNextRun(4, 'Europe/Paris', at('2026-08-12T23:00:00Z'));

    assert.equal(delay, 3 * 3_600_000);
  });

  test('reporte au lendemain quand l\'heure est passée', () => {
    // 10h00 heure de Paris : 4h est derrière nous, il reste 18 heures.
    const delay = msUntilNextRun(4, 'Europe/Paris', at('2026-08-13T08:00:00Z'));

    assert.equal(delay, 18 * 3_600_000);
  });

  test('reste dans les vingt-quatre heures quelle que soit l\'heure', () => {
    for (let heure = 0; heure < 24; heure += 1) {
      const delay = msUntilNextRun(4, 'Europe/Paris', at(`2026-08-13T${String(heure).padStart(2, '0')}:30:00Z`));

      assert.ok(delay > 0 && delay <= 86_400_000, `heure ${heure} : ${delay} ms`);
    }
  });

  test('raisonne en heure locale et non en UTC', () => {
    // Le même instant vise 4h Paris et 4h Tokyo à des moments différents.
    const instant = at('2026-08-13T08:00:00Z');

    assert.notEqual(
      msUntilNextRun(4, 'Europe/Paris', instant),
      msUntilNextRun(4, 'Asia/Tokyo', instant),
    );
  });

  test('lit minuit comme 0 et non comme 24', () => {
    // En hourCycle h24, minuit se lit « 24 » et le calcul serait faux d'un jour.
    const delay = msUntilNextRun(4, 'UTC', at('2026-08-13T00:00:00Z'));

    assert.equal(delay, 4 * 3_600_000);
  });
});
