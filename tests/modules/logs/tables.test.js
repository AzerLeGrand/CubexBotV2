import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createDatabase } from '../../../src/core/database/index.js';
import { CORE_OWNER } from '../../../src/core/database/migrations.js';
import { ANONYMOUS_USER_ID, createErasureRegistry } from '../../../src/core/erasure/index.js';
import { createPurgeRegistry } from '../../../src/core/purge/index.js';
import {
  ACTOR_CONFIDENCE,
  ACTOR_CONFIDENCE_VALUES,
  EVENT_SOURCE,
  EVENT_SOURCE_VALUES,
} from '../../../src/modules/logs/constants.js';
import { erasure, name, retention } from '../../../src/modules/logs/index.js';
import { createLogRepository } from '../../../src/modules/logs/repository.js';
import { fromRoot } from '../../../src/utils/paths.js';

/**
 * Schéma du module et déclarations aux deux registres du socle.
 *
 * Les migrations sont appliquées ici telles que le démarrage les applique, sur
 * une base réelle : c'est le seul moyen de prouver que le registre de purge
 * accepte les tables, que le format d'horodatage passe son contrôle, et
 * qu'`anonymize` n'est refusé sur aucune des deux colonnes déclarées.
 */

const MEMBRE = '123456789012345678';
const AUTRE = '987654321098765432';
const MODERATEUR = '111111111111111111';
const SALON = '222222222222222222';

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

/** Sources telles que `src/index.js` les assemble : le noyau, puis les modules. */
const SOURCES = [
  { owner: CORE_OWNER, directory: fromRoot('migrations') },
  { owner: name, directory: fromRoot('src', 'modules', 'logs', 'migrations') },
];

const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

const sandbox = (t, { migrate = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'cubex-logs-'));
  const logger = fakeLogger();
  const database = createDatabase({ file: join(root, 'test.sqlite'), logger });

  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  if (migrate) database.migrate(SOURCES);

  const rows = (table) => database.prepare(`SELECT * FROM ${table}`).all();

  return { database, logger, rows };
};

const columns = (database, table) =>
  Object.fromEntries(
    database.prepare(`PRAGMA table_info(${table})`).all().map((column) => [column.name, column]),
  );

/** Événement minimal, complété au cas par cas. */
const event = (patch = {}) => ({
  eventType: 'message_delete',
  occurredAt: new Date().toISOString(),
  actorId: null,
  actorConfidence: ACTOR_CONFIDENCE.unknown,
  targetId: MEMBRE,
  channelId: SALON,
  source: EVENT_SOURCE.live,
  data: {},
  ...patch,
});

describe('schéma', () => {
  test('les deux tables existent après migration', (t) => {
    const { database } = sandbox(t);

    const noms = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);

    assert.deepEqual(noms, ['log_events', 'log_message_content', 'schema_migrations']);
  });

  test('log_events : identifiants en TEXT, auteur et cible nullables', (t) => {
    const { database } = sandbox(t);
    const held = columns(database, 'log_events');

    assert.equal(held.id.pk, 1);
    assert.equal(held.event_type.notnull, 1);
    assert.equal(held.occurred_at.type, 'TEXT');
    assert.equal(held.occurred_at.notnull, 1);

    // TEXT sans exception : au-delà de 16 chiffres, un identifiant lu comme
    // entier est tronqué silencieusement.
    for (const colonne of ['actor_id', 'target_id', 'channel_id', 'audit_log_entry_id']) {
      assert.equal(held[colonne].type, 'TEXT', colonne);
      // Discord n'inscrit rien au journal d'audit quand un membre supprime son
      // propre message : l'auteur reste inconnu, et la colonne doit l'admettre.
      assert.equal(held[colonne].notnull, 0, colonne);
    }

    assert.equal(held.data.notnull, 1);
  });

  test('log_events.id est un AUTOINCREMENT, jamais réattribué', (t) => {
    // La purge supprime des lignes tous les jours. Sans AUTOINCREMENT, SQLite
    // réattribue l'identifiant des lignes supprimées, et un ancien contenu
    // pourrait se rattacher à un nouvel événement.
    const { database } = sandbox(t);

    const ddl = database
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'log_events'")
      .get().sql;

    assert.match(ddl, /AUTOINCREMENT/);
  });

  test('les deux contraintes CHECK refusent une valeur hors jeu', (t) => {
    const { database } = sandbox(t);
    const repository = createLogRepository({ database });

    assert.throws(
      () => repository.insertEvent(event({ actorConfidence: 'peut_etre' })),
      /CHECK constraint failed/,
    );

    assert.throws(() => repository.insertEvent(event({ source: 'replay' })), /CHECK constraint failed/);

    // Et le jeu déclaré passe intégralement.
    for (const confiance of ACTOR_CONFIDENCE_VALUES) {
      assert.doesNotThrow(() => repository.insertEvent(event({ actorConfidence: confiance })));
    }

    for (const source of EVENT_SOURCE_VALUES) {
      assert.doesNotThrow(() => repository.insertEvent(event({ source })));
    }
  });

  test('log_message_content : clé étrangère en CASCADE sur l\'événement', (t) => {
    const { database } = sandbox(t);
    const held = columns(database, 'log_message_content');

    assert.equal(held.event_id.pk, 1);
    assert.equal(held.created_at.notnull, 1);

    // Existe pour l'effacement RGPD : sans elle, la table serait inatteignable
    // par le registre, et le contenu des messages survivrait à la demande.
    assert.equal(held.author_id.type, 'TEXT');
    assert.equal(held.author_id.notnull, 0);

    const [key] = database.prepare('PRAGMA foreign_key_list(log_message_content)').all();

    assert.equal(key.table, 'log_events');
    assert.equal(key.from, 'event_id');
    assert.equal(key.to, 'id');
    assert.equal(key.on_delete, 'CASCADE');
  });

  test('le pragma foreign_keys est actif : le CASCADE joue réellement', (t) => {
    const { database, rows } = sandbox(t);
    const repository = createLogRepository({ database });

    const id = repository.insertEvent(event({ content: { authorId: MEMBRE, before: 'salut' } }));

    database.prepare('DELETE FROM log_events WHERE id = ?').run(id);

    assert.equal(rows('log_message_content').length, 0, 'le contenu part avec son événement');
  });

  test('les trois index de log_events sont créés, un seul unique', (t) => {
    const { database } = sandbox(t);

    const parNom = Object.fromEntries(
      database.prepare('PRAGMA index_list(log_events)').all().map((entry) => [entry.name, entry]),
    );

    assert.equal(parNom.idx_log_events_target_id.unique, 0, 'un membre a plusieurs événements');
    assert.equal(parNom.idx_log_events_occurred_at.unique, 0);
    assert.equal(parNom.idx_log_events_audit_log_entry_id.unique, 1, 'dédoublonnage du rattrapage');
  });

  test('l\'unique sur audit_log_entry_id tolère plusieurs NULL', (t) => {
    // SQLite ne considère jamais deux NULL comme égaux au sens d'une contrainte
    // d'unicité : les événements sans entrée d'audit, qui sont la majorité, ne
    // se gênent pas.
    const { database, rows } = sandbox(t);
    const repository = createLogRepository({ database });

    for (let i = 0; i < 3; i += 1) repository.insertEvent(event({ auditLogEntryId: null }));

    assert.equal(rows('log_events').length, 3);

    repository.insertEvent(event({ auditLogEntryId: '555' }));

    assert.throws(
      () => repository.insertEvent(event({ auditLogEntryId: '555' })),
      /UNIQUE constraint failed/,
    );
  });

  test('aucun horodatage ne porte de valeur par défaut', (t) => {
    // datetime('now') produit un espace au lieu du T : toutes les lignes du jour
    // passeraient pour antérieures au seuil de purge.
    const { database } = sandbox(t);

    assert.equal(columns(database, 'log_events').occurred_at.dflt_value, null);
    assert.equal(columns(database, 'log_message_content').created_at.dflt_value, null);
  });
});

describe('application des migrations', () => {
  test('s\'applique sur une base vierge et s\'inscrit au suivi', (t) => {
    const { database } = sandbox(t, { migrate: false });

    const result = database.migrate(SOURCES);

    assert.deepEqual(result.applied, ['logs/001']);

    const suivi = database.prepare('SELECT * FROM schema_migrations WHERE owner = ?').all(name);

    assert.equal(suivi.length, 1);
    assert.equal(suivi[0].number, 1);
    assert.equal(suivi[0].name, 'tables');
  });

  test('un second passage n\'applique rien', (t) => {
    const { database } = sandbox(t);

    assert.deepEqual(database.migrate(SOURCES).applied, []);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 1);
  });

  test('rejouable indéfiniment sans erreur', (t) => {
    const { database } = sandbox(t);

    for (let i = 0; i < 3; i += 1) assert.doesNotThrow(() => database.migrate(SOURCES));
  });
});

describe('déclarations aux registres', () => {
  const registres = (t) => {
    const { database, logger, rows } = sandbox(t);

    return {
      database,
      logger,
      rows,
      repository: createLogRepository({ database }),
      purge: createPurgeRegistry({ database, config: fakeConfig, logger }),
      erasure: createErasureRegistry({ database, logger }),
    };
  };

  test('la purge accepte les deux déclarations', (t) => {
    const { purge } = registres(t);

    // Le registre inspecte la table : l'acceptation prouve que les deux
    // colonnes de date existent réellement.
    assert.doesNotThrow(() => purge.register(name, retention));
    assert.equal(purge.size, 2);
  });

  test('le contenu est déclaré avant les métadonnées', (t) => {
    // La suppression d'un événement entraîne celle de son contenu par CASCADE :
    // l'ordre inverse ferait compter des lignes déjà parties.
    assert.deepEqual(
      retention.map((entry) => entry.table),
      ['log_message_content', 'log_events'],
    );

    assert.deepEqual(
      retention.map((entry) => entry.retention_key),
      ['logs.retention.message_content_days', 'logs.retention.structural_days'],
    );
  });

  test('le contrôle de format ISO passe sur une ligne écrite par le dépôt', (t) => {
    // toISOString() produit le T que le registre exige. Sans lui, la comparaison
    // lexicographique décalerait la purge d'une journée, tous les jours.
    const { purge, repository, logger } = registres(t);

    purge.register(name, retention);
    repository.insertEvent(event({ content: { authorId: MEMBRE, before: 'salut' } }));

    const report = purge.run();

    assert.equal(report.length, 2);
    for (const ligne of report) {
      assert.equal(ligne.error, undefined, ligne.table);
      assert.notEqual(ligne.deferred, true, `${ligne.table} : la table n'est pas vide`);
    }

    assert.equal(logger.of('error').length, 0);
  });

  test('la purge retire ce qui dépasse chaque seuil, séparément', (t) => {
    const { purge, repository, rows } = registres(t);

    purge.register(name, retention);

    // Contenu de 40 jours : au-delà des 30 du contenu, en deçà des 90 des
    // métadonnées. C'est exactement ce que la séparation des deux tables sert à
    // obtenir.
    repository.insertEvent(
      event({ occurredAt: daysAgo(40), content: { authorId: MEMBRE, before: 'vieux' } }),
    );
    repository.insertEvent(
      event({ occurredAt: daysAgo(10), content: { authorId: MEMBRE, before: 'récent' } }),
    );
    repository.insertEvent(event({ occurredAt: daysAgo(100) }));

    purge.run();

    assert.equal(rows('log_message_content').length, 1, 'seul le contenu de 10 jours reste');
    assert.equal(rows('log_events').length, 2, 'les métadonnées de 40 jours survivent');
  });

  test('l\'effacement accepte les trois déclarations, anonymize compris', (t) => {
    const { erasure: registry } = registres(t);

    // Le garde-fou du socle refuse anonymize sur une colonne portant une
    // contrainte d'unicité. Ni actor_id ni target_id n'en portent — le seul
    // index unique du module est sur audit_log_entry_id — et c'est ce que
    // l'acceptation prouve sur la vraie table.
    assert.doesNotThrow(() => registry.register(name, erasure));
    assert.equal(registry.size, 3);
    assert.deepEqual(registry.tables(), [
      'logs/log_message_content',
      'logs/log_events',
      'logs/log_events',
    ]);
  });

  test('anonymize resterait refusé sur une colonne unique de la même table', (t) => {
    // Contre-épreuve : sans elle, le test précédent passerait même si le
    // garde-fou ne s'appliquait plus.
    const { erasure: registry } = registres(t);

    assert.throws(
      () =>
        registry.register(name, [
          { table: 'log_events', user_column: 'audit_log_entry_id', strategy: 'anonymize' },
        ]),
      /anonymize est impossible sur log_events\.audit_log_entry_id/,
    );
  });
});

describe('effacement sur une base peuplée', () => {
  const peupler = (t) => {
    const { database, logger, rows } = sandbox(t);
    const registry = createErasureRegistry({ database, logger });
    const repository = createLogRepository({ database });

    registry.register(name, erasure);

    // Un message de MEMBRE, supprimé par lui-même : contenu et cible sont lui.
    repository.insertEvent(
      event({ targetId: MEMBRE, content: { authorId: MEMBRE, before: 'son message' } }),
    );

    // Un message d'AUTRE, supprimé par MEMBRE agissant comme modérateur.
    repository.insertEvent(
      event({
        actorId: MEMBRE,
        actorConfidence: ACTOR_CONFIDENCE.probable,
        targetId: AUTRE,
        content: { authorId: AUTRE, before: 'le message d\'un tiers' },
      }),
    );

    // Et une action d'un tiers sur un tiers : elle ne doit pas bouger.
    repository.insertEvent(
      event({
        eventType: 'member_ban',
        actorId: MODERATEUR,
        actorConfidence: ACTOR_CONFIDENCE.certain,
        targetId: AUTRE,
        channelId: null,
      }),
    );

    return { registry, rows };
  };

  test('supprime le contenu du membre, et lui seul', (t) => {
    const { registry, rows } = peupler(t);

    registry.erase(MEMBRE);

    // Le contenu EST la donnée personnelle : il disparaît. Celui d'AUTRE reste.
    assert.deepEqual(
      rows('log_message_content').map((row) => row.author_id),
      [AUTRE],
    );
  });

  test('anonymise les métadonnées au lieu de supprimer les lignes', (t) => {
    const { registry, rows } = peupler(t);

    registry.erase(MEMBRE);

    // `delete` sur actor_id aurait supprimé l'événement visant AUTRE, donc les
    // données d'un membre qui n'a rien demandé.
    assert.equal(rows('log_events').length, 3, 'aucune ligne de métadonnées perdue');

    assert.deepEqual(
      rows('log_events').map((row) => [row.actor_id, row.target_id]),
      [
        [null, ANONYMOUS_USER_ID],
        [ANONYMOUS_USER_ID, AUTRE],
        [MODERATEUR, AUTRE],
      ],
    );
  });

  test('le compte rendu distingue les trois déclarations', (t) => {
    const { registry } = peupler(t);

    const report = registry.erase(MEMBRE);

    assert.deepEqual(report, [
      { owner: name, table: 'log_message_content', strategy: 'delete', affected: 1 },
      { owner: name, table: 'log_events', strategy: 'anonymize', affected: 1 },
      { owner: name, table: 'log_events', strategy: 'anonymize', affected: 1 },
    ]);
  });

  test('reste sans effet sur un membre inconnu', (t) => {
    const { registry, rows } = peupler(t);

    registry.erase('444444444444444444');

    assert.equal(rows('log_events').length, 3);
    assert.equal(rows('log_message_content').length, 2);
  });

  test('un second effacement du même membre ne casse rien', (t) => {
    // Le mode de défaillance que le garde-fou du socle ferme : anonymize écrit
    // la même valeur de remplacement sur chaque ligne, et heurterait une
    // contrainte d'unicité au deuxième passage.
    const { registry } = peupler(t);

    registry.erase(MEMBRE);

    assert.doesNotThrow(() => registry.erase(MEMBRE));
    assert.doesNotThrow(() => registry.erase(AUTRE));
  });
});
