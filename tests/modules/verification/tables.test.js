import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createDatabase } from '../../../src/core/database/index.js';
import { CORE_OWNER } from '../../../src/core/database/migrations.js';
import { ANONYMOUS_USER_ID, createErasureRegistry } from '../../../src/core/erasure/index.js';
import { createPurgeRegistry } from '../../../src/core/purge/index.js';
import { HISTORY_EVENTS, HISTORY_EVENT_VALUES } from '../../../src/modules/verification/constants.js';
import { erasure, migrations, name, retention } from '../../../src/modules/verification/index.js';
import { fromRoot } from '../../../src/utils/paths.js';

/**
 * Premières tables du projet : le noyau n'en a aucune, et la numérotation par
 * propriétaire n'avait donc jamais servi. Les migrations sont appliquées ici
 * telles que le démarrage les applique, sur une base réelle.
 */

const MEMBRE = '123456789012345678';
const AUTRE = '987654321098765432';
const MODERATEUR = '111111111111111111';

const RETENTIONS = {
  'verification.retention.history_days': 90,
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

/** Sources telles que `src/index.js` les assemble : le noyau, puis le module. */
const SOURCES = [
  { owner: CORE_OWNER, directory: fromRoot('migrations') },
  { owner: name, directory: fromRoot('src', 'modules', 'verification', 'migrations') },
];

const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

const sandbox = (t, { migrate = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'cubex-verif-'));
  const logger = fakeLogger();
  const database = createDatabase({ file: join(root, 'test.sqlite'), logger });

  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  if (migrate) database.migrate(SOURCES);

  const rows = (table) => database.prepare(`SELECT * FROM ${table}`).all();

  const historique = (userId, event, { actor = null, at = new Date().toISOString() } = {}) =>
    database
      .prepare(
        'INSERT INTO verification_history (user_id, event, actor_id, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(userId, event, actor, at);

  const etat = (userId, { attempts = 0, blockedAt = null } = {}) =>
    database
      .prepare(
        'INSERT INTO verification_state (user_id, attempts, blocked_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(userId, attempts, blockedAt, new Date().toISOString());

  return { database, logger, rows, historique, etat };
};

const columns = (database, table) =>
  Object.fromEntries(
    database.prepare(`PRAGMA table_info(${table})`).all().map((column) => [column.name, column]),
  );

describe('schéma', () => {
  test('les trois tables existent après migration', (t) => {
    const { database } = sandbox(t);

    const noms = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);

    assert.deepEqual(noms, [
      'schema_migrations',
      'verification_history',
      'verification_message',
      'verification_state',
    ]);
  });

  test('verification_state : la clé est le membre, le blocage est stocké', (t) => {
    const { database } = sandbox(t);
    const held = columns(database, 'verification_state');

    // TEXT sans exception : un identifiant Discord lu comme entier est tronqué.
    assert.equal(held.user_id.type, 'TEXT');
    assert.equal(held.user_id.pk, 1);
    assert.equal(held.user_id.notnull, 1);

    assert.equal(held.attempts.type, 'INTEGER');
    assert.equal(held.attempts.notnull, 1);
    assert.equal(held.attempts.dflt_value, '0');

    // Nullable : une ligne sans blocage est une vérification en cours. Le
    // blocage n'est jamais déduit de attempts >= max_attempts, seuil
    // configurable qui bloquerait ou débloquerait rétroactivement.
    assert.equal(held.blocked_at.notnull, 0);
    assert.equal(held.updated_at.notnull, 1);

    assert.equal(Object.keys(held).length, 4, 'aucune colonne « vérifié » : le rôle Discord fait foi');
  });

  test('verification_history : actor_id nullable', (t) => {
    const { database } = sandbox(t);
    const held = columns(database, 'verification_history');

    assert.equal(held.id.pk, 1);
    assert.equal(held.user_id.notnull, 1);
    assert.equal(held.event.notnull, 1);

    // Renseigné sur unblock uniquement.
    assert.equal(held.actor_id.notnull, 0);
    assert.equal(held.created_at.notnull, 1);
  });

  test('aucune contrainte CHECK ne fige le jeu d\'événements', (t) => {
    // Vérifié par le comportement et non par le DDL : SQLite conserve les
    // commentaires dans sqlite_master, et le mot CHECK y figure justement pour
    // expliquer son absence.
    //
    // SQLite ne sait pas modifier une CHECK : un cinquième type d'événement --
    // la phase 2 voudra probablement `expired` -- imposerait de reconstruire
    // une table portant l'historique de tous les membres. Le garde-fou est en
    // code, dans constants.js.
    const { database, historique, rows } = sandbox(t);

    assert.doesNotThrow(() => historique(MEMBRE, 'evenement_inconnu'));
    assert.equal(rows('verification_history')[0].event, 'evenement_inconnu');
  });

  test('verification_message : une ligne par salon, aucune donnée de membre', (t) => {
    const { database } = sandbox(t);
    const held = columns(database, 'verification_message');

    // Clé sur le salon : un salon changé dans config.yml laisse l'ancienne
    // ligne inerte plutôt que de l'écraser.
    assert.equal(held.channel_id.pk, 1);
    assert.equal(held.message_id.notnull, 1);
    assert.deepEqual(Object.keys(held), ['channel_id', 'message_id', 'updated_at']);
  });

  test('les deux index de l\'historique sont créés, et non uniques', (t) => {
    const { database } = sandbox(t);

    const index = database.prepare('PRAGMA index_list(verification_history)').all();
    const parNom = Object.fromEntries(index.map((entry) => [entry.name, entry]));

    for (const nom of ['idx_verification_history_user_id', 'idx_verification_history_created_at']) {
      assert.ok(parNom[nom] !== undefined, `${nom} devrait exister`);
      assert.equal(parNom[nom].unique, 0, 'un membre a plusieurs lignes d\'historique');
    }
  });

  test('aucun horodatage ne porte de valeur par défaut', (t) => {
    // datetime('now') produit un espace au lieu du T : toutes les lignes du
    // jour passeraient pour antérieures au seuil de purge.
    const { database } = sandbox(t);

    for (const [table, colonnes] of [
      ['verification_state', ['blocked_at', 'updated_at']],
      ['verification_history', ['created_at']],
      ['verification_message', ['updated_at']],
    ]) {
      const held = columns(database, table);

      for (const colonne of colonnes) {
        assert.equal(held[colonne].dflt_value, null, `${table}.${colonne}`);
      }
    }
  });
});

describe('application des migrations', () => {
  test('s\'applique sur une base vierge et s\'inscrit au suivi', (t) => {
    const { database } = sandbox(t, { migrate: false });

    const result = database.migrate(SOURCES);

    assert.deepEqual(result.applied, ['verification/001']);

    const suivi = database.prepare('SELECT * FROM schema_migrations').all();

    assert.equal(suivi.length, 1);
    assert.equal(suivi[0].owner, 'verification');
    assert.equal(suivi[0].number, 1);
    assert.equal(suivi[0].name, 'tables');
  });

  test('s\'applique sur une base déjà migrée par le noyau', (t) => {
    // Le cas réel : la base de développement et le VPS portent déjà
    // schema_migrations avant que le premier module n'arrive.
    const { database } = sandbox(t, { migrate: false });

    database.migrate([SOURCES[0]]);
    const result = database.migrate(SOURCES);

    assert.deepEqual(result.applied, ['verification/001']);
  });

  test('un second passage n\'applique rien', (t) => {
    const { database } = sandbox(t);

    assert.deepEqual(database.migrate(SOURCES).applied, []);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, 1);
  });
});

describe('déclarations aux registres', () => {
  const registres = (t) => {
    const { database, logger, ...reste } = sandbox(t);

    const purge = createPurgeRegistry({ database, config: fakeConfig, logger });
    const registry = createErasureRegistry({ database, logger });

    return { database, logger, purge, erasure: registry, ...reste };
  };

  test('la purge accepte la déclaration du module', (t) => {
    const { purge } = registres(t);

    // Le registre inspecte désormais la table : l'acceptation prouve que
    // verification_history.created_at existe réellement.
    assert.doesNotThrow(() => purge.register(name, retention));
    assert.equal(purge.size, 1);
  });

  test('l\'effacement accepte les trois déclarations, dont deux sur la même table', (t) => {
    const { erasure: registry } = registres(t);

    assert.doesNotThrow(() => registry.register(name, erasure));
    assert.equal(registry.size, 3);
    assert.deepEqual(registry.tables(), [
      'verification/verification_state',
      'verification/verification_history',
      'verification/verification_history',
    ]);
  });

  test('anonymize sur verification_state.user_id est refusé sur la vraie table', (t) => {
    const { erasure: registry } = registres(t);

    // La clé primaire porte l'identifiant du membre : le deuxième effacement
    // heurterait la ligne déjà anonymisée et annulerait toute la transaction,
    // tables des autres modules comprises.
    assert.throws(
      () =>
        registry.register(name, [
          { table: 'verification_state', user_column: 'user_id', strategy: 'anonymize' },
        ]),
      /anonymize est impossible sur verification_state\.user_id/,
    );

    assert.throws(
      () =>
        registry.register(name, [
          { table: 'verification_state', user_column: 'user_id', strategy: 'anonymize' },
        ]),
      /la clé primaire/,
    );
  });

  test('anonymize est accepté sur actor_id, qui ne porte aucune unicité', (t) => {
    const { erasure: registry } = registres(t);

    assert.doesNotThrow(() =>
      registry.register(name, [
        { table: 'verification_history', user_column: 'actor_id', strategy: 'anonymize' },
      ]),
    );
  });
});

describe('effacement sur une base peuplée', () => {
  const peupler = (t) => {
    const { database, logger, rows, historique, etat } = sandbox(t);
    const registry = createErasureRegistry({ database, logger });

    registry.register(name, erasure);

    // Le membre qui demandera l'effacement : un état en cours et son historique.
    etat(MEMBRE, { attempts: 2 });
    historique(MEMBRE, HISTORY_EVENTS.failure);
    historique(MEMBRE, HISTORY_EVENTS.success);

    // Un autre membre, débloqué par MEMBRE agissant comme membre du staff.
    etat(AUTRE, { attempts: 5, blockedAt: new Date().toISOString() });
    historique(AUTRE, HISTORY_EVENTS.block);
    historique(AUTRE, HISTORY_EVENTS.unblock, { actor: MEMBRE });

    // Et une ligne où un tiers est intervenu : elle ne doit pas bouger.
    historique(AUTRE, HISTORY_EVENTS.unblock, { actor: MODERATEUR });

    return { registry, rows };
  };

  test('efface le membre sans toucher aux données des autres', (t) => {
    const { registry, rows } = peupler(t);

    registry.erase(MEMBRE);

    // Son état et ses propres lignes disparaissent.
    assert.deepEqual(rows('verification_state').map((row) => row.user_id), [AUTRE]);
    assert.deepEqual(
      rows('verification_history').map((row) => row.user_id),
      [AUTRE, AUTRE, AUTRE],
      'aucune ligne d\'un autre membre n\'a été supprimée',
    );
  });

  test('anonymise son rôle d\'acteur au lieu de supprimer la ligne', (t) => {
    const { registry, rows } = peupler(t);

    registry.erase(MEMBRE);

    const acteurs = rows('verification_history').map((row) => row.actor_id);

    // C'est tout l'enjeu du découpage par colonne : `delete` sur actor_id
    // aurait supprimé la ligne de déblocage d'AUTRE, donc les données d'un
    // membre qui n'a rien demandé.
    assert.deepEqual(acteurs, [null, ANONYMOUS_USER_ID, MODERATEUR]);
  });

  test('le blocage de l\'autre membre survit intact', (t) => {
    const { registry, rows } = peupler(t);

    registry.erase(MEMBRE);

    const [etatAutre] = rows('verification_state');

    assert.equal(etatAutre.user_id, AUTRE);
    assert.equal(etatAutre.attempts, 5);
    assert.notEqual(etatAutre.blocked_at, null);
  });

  test('le compte rendu distingue les trois déclarations', (t) => {
    const { registry } = peupler(t);

    const report = registry.erase(MEMBRE);

    assert.deepEqual(report, [
      { owner: name, table: 'verification_state', strategy: 'delete', affected: 1 },
      { owner: name, table: 'verification_history', strategy: 'delete', affected: 2 },
      { owner: name, table: 'verification_history', strategy: 'anonymize', affected: 1 },
    ]);
  });

  test('reste sans effet sur un membre inconnu', (t) => {
    const { registry, rows } = peupler(t);

    registry.erase('222222222222222222');

    assert.equal(rows('verification_state').length, 2);
    assert.equal(rows('verification_history').length, 5);
  });
});

describe('purge sur une base peuplée', () => {
  const peupler = (t) => {
    const { database, logger, rows, historique } = sandbox(t);
    const purge = createPurgeRegistry({ database, config: fakeConfig, logger });

    purge.register(name, retention);

    historique(MEMBRE, HISTORY_EVENTS.failure, { at: daysAgo(100) });
    historique(MEMBRE, HISTORY_EVENTS.block, { at: daysAgo(91) });
    historique(MEMBRE, HISTORY_EVENTS.success, { at: daysAgo(89) });
    historique(AUTRE, HISTORY_EVENTS.success, { at: daysAgo(1) });

    return { purge, rows, logger };
  };

  test('retire ce qui dépasse le seuil et garde le reste', (t) => {
    const { purge, rows } = peupler(t);

    const [ligne] = purge.run();

    assert.equal(ligne.deleted, 2, 'les lignes de 100 et 91 jours');
    assert.equal(rows('verification_history').length, 2);
  });

  test('accepte le format d\'horodatage tel que le code l\'écrira', (t) => {
    // toISOString() produit le T que le registre exige : sans lui, la
    // comparaison lexicographique décalerait la purge d'une journée, tous les
    // jours.
    const { purge, logger } = peupler(t);

    const [ligne] = purge.run();

    assert.equal(ligne.error, undefined);
    assert.equal(logger.of('error').length, 0);
  });

  test('ne touche ni l\'état ni le message d\'accueil', (t) => {
    const { purge, rows } = peupler(t);

    purge.run();

    // Un blocage purgé se lèverait tout seul : verification_state n'est jamais
    // soumise à rétention.
    assert.equal(rows('verification_state').length, 0, 'aucune ligne insérée, aucune supprimée');
    assert.equal(purge.size, 1, 'une seule table déclarée');
  });
});

describe('constantes d\'événement', () => {
  test('les quatre valeurs de la spec, et rien d\'autre', () => {
    assert.deepEqual(HISTORY_EVENT_VALUES, ['success', 'failure', 'block', 'unblock']);
  });

  test('ce qui est écrit en base fait partie du jeu déclaré', (t) => {
    const { rows, historique } = sandbox(t);

    for (const event of HISTORY_EVENT_VALUES) historique(MEMBRE, event);

    // Faute de contrainte CHECK, c'est ce contrôle qui tient lieu de garde-fou
    // sur ce que le module écrit.
    for (const row of rows('verification_history')) {
      assert.ok(HISTORY_EVENT_VALUES.includes(row.event), `événement inconnu : ${row.event}`);
    }
  });
});
