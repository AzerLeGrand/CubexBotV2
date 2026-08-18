import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createDatabase } from '../../../src/core/database/index.js';
import { CORE_OWNER } from '../../../src/core/database/migrations.js';
import { ACTOR_CONFIDENCE, EVENT_SOURCE } from '../../../src/modules/logs/constants.js';
import { name } from '../../../src/modules/logs/index.js';
import { createLogRepository } from '../../../src/modules/logs/repository.js';
import { fromRoot } from '../../../src/utils/paths.js';

/**
 * Dépôt d'écriture du module.
 *
 * Aucun appel à Discord n'est en jeu ici : l'écriture en base est immédiate et
 * indépendante du groupement d'affichage. Deux propriétés sont testées de près,
 * parce qu'elles ne se voient pas à la lecture du code appelant : l'atomicité de
 * l'insertion, et le fait que la recherche par membre ne rende jamais de
 * contenu.
 */

const MEMBRE = '123456789012345678';
const AUTRE = '987654321098765432';
const MODERATEUR = '111111111111111111';
const SALON = '222222222222222222';

const fakeLogger = () => {
  const record = () => () => {};

  return { error: record(), warn: record(), info: record(), debug: record() };
};

const SOURCES = [
  { owner: CORE_OWNER, directory: fromRoot('migrations') },
  { owner: name, directory: fromRoot('src', 'modules', 'logs', 'migrations') },
];

const sandbox = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cubex-logs-repo-'));
  const database = createDatabase({ file: join(root, 'test.sqlite'), logger: fakeLogger() });

  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  database.migrate(SOURCES);

  return {
    database,
    repository: createLogRepository({ database }),
    rows: (table) => database.prepare(`SELECT * FROM ${table}`).all(),
  };
};

const event = (patch = {}) => ({
  eventType: 'message_delete',
  occurredAt: new Date().toISOString(),
  actorConfidence: ACTOR_CONFIDENCE.unknown,
  targetId: MEMBRE,
  channelId: SALON,
  source: EVENT_SOURCE.live,
  ...patch,
});

describe('insertEvent', () => {
  test('écrit les métadonnées et rend l\'identifiant inséré', (t) => {
    const { repository, rows } = sandbox(t);

    const id = repository.insertEvent(
      event({
        actorId: MODERATEUR,
        actorConfidence: ACTOR_CONFIDENCE.probable,
        auditLogEntryId: '777',
        data: { reason: 'spam' },
      }),
    );

    assert.equal(typeof id, 'number', 'un BigInt filerait mal dans le reste du module');

    const [ligne] = rows('log_events');

    assert.equal(ligne.id, id);
    assert.equal(ligne.event_type, 'message_delete');
    assert.equal(ligne.actor_id, MODERATEUR);
    assert.equal(ligne.actor_confidence, ACTOR_CONFIDENCE.probable);
    assert.equal(ligne.target_id, MEMBRE);
    assert.equal(ligne.channel_id, SALON);
    assert.equal(ligne.source, EVENT_SOURCE.live);
    assert.equal(ligne.audit_log_entry_id, '777');
    assert.deepEqual(JSON.parse(ligne.data), { reason: 'spam' });
  });

  test('sans contenu, n\'écrit que la table des métadonnées', (t) => {
    const { repository, rows } = sandbox(t);

    repository.insertEvent(event({ eventType: 'member_ban', channelId: null }));

    assert.equal(rows('log_events').length, 1);
    assert.equal(rows('log_message_content').length, 0);
  });

  test('avec contenu, écrit les deux tables et les relie', (t) => {
    const { repository, rows } = sandbox(t);

    const id = repository.insertEvent(
      event({
        content: {
          authorId: MEMBRE,
          before: 'avant',
          after: 'après',
          attachments: [{ name: 'photo.png', size: 4096 }],
        },
      }),
    );

    const [contenu] = rows('log_message_content');

    assert.equal(contenu.event_id, id);
    assert.equal(contenu.author_id, MEMBRE);
    assert.equal(contenu.content_before, 'avant');
    assert.equal(contenu.content_after, 'après');
    assert.deepEqual(JSON.parse(contenu.attachments), [{ name: 'photo.png', size: 4096 }]);
  });

  test('created_at du contenu recopie occurred_at de l\'événement', (t) => {
    // Les deux tables portent le même instant sous deux rétentions différentes.
    // Les dissocier ouvrirait la porte à un contenu purgé avant ou après son
    // propre événement.
    const { repository, rows } = sandbox(t);
    const at = '2026-08-18T14:32:07.512Z';

    repository.insertEvent(event({ occurredAt: at, content: { authorId: MEMBRE, before: 'x' } }));

    assert.equal(rows('log_events')[0].occurred_at, at);
    assert.equal(rows('log_message_content')[0].created_at, at);
  });

  test('l\'absence de pièce jointe reste NULL, jamais "[]"', (t) => {
    const { repository, rows } = sandbox(t);

    repository.insertEvent(event({ content: { authorId: MEMBRE, before: 'sans fichier' } }));

    const [contenu] = rows('log_message_content');

    assert.equal(contenu.attachments, null);
    assert.equal(contenu.content_after, null, 'une suppression n\'a pas de contenu après');
  });

  test('data absente est sérialisée en objet vide, jamais NULL', (t) => {
    // La colonne est NOT NULL : un appelant qui n'a rien de particulier à dire
    // ne doit pas faire échouer l'insertion.
    const { repository, rows } = sandbox(t);

    repository.insertEvent(event());

    assert.deepEqual(JSON.parse(rows('log_events')[0].data), {});
  });

  test('rien n\'est écrit dans log_events si l\'insertion du contenu échoue', (t) => {
    // LA propriété du lot : un arrêt entre les deux écritures laisserait une
    // ligne de métadonnées annonçant un contenu qui n'existe pas. L'affichage
    // promettrait un message supprimé et n'aurait rien à montrer.
    const { repository, rows } = sandbox(t);

    // Sérialisation impossible : la panne se produit APRÈS l'insertion des
    // métadonnées, ce qui est exactement le moment à couvrir.
    const circulaire = { name: 'boucle.png' };
    circulaire.self = circulaire;

    assert.throws(() =>
      repository.insertEvent(event({ content: { authorId: MEMBRE, attachments: circulaire } })),
    );

    assert.equal(rows('log_events').length, 0, 'la transaction a été annulée');
    assert.equal(rows('log_message_content').length, 0);
  });

  test('une insertion réussie après un échec repart proprement', (t) => {
    const { repository, rows } = sandbox(t);

    const circulaire = {};
    circulaire.self = circulaire;

    assert.throws(() => repository.insertEvent(event({ content: { attachments: circulaire } })));
    assert.doesNotThrow(() => repository.insertEvent(event()));

    assert.equal(rows('log_events').length, 1);
  });
});

describe('findByTarget', () => {
  const peupler = (t) => {
    const { repository, ...reste } = sandbox(t);

    for (const [index, [occurredAt, eventType]] of [
      ['2026-08-01T10:00:00.000Z', 'message_delete'],
      ['2026-08-02T10:00:00.000Z', 'message_edit'],
      ['2026-08-03T10:00:00.000Z', 'message_bulk_delete'],
    ].entries()) {
      repository.insertEvent(
        event({
          occurredAt,
          eventType,
          content: { authorId: MEMBRE, before: `SECRET ${index}` },
        }),
      );
    }

    // Un événement visant quelqu'un d'autre : il ne doit jamais remonter.
    repository.insertEvent(
      event({ occurredAt: '2026-08-04T10:00:00.000Z', targetId: AUTRE, eventType: 'member_ban' }),
    );

    return { repository, ...reste };
  };

  test('NE REND JAMAIS DE CONTENU DE MESSAGE', (t) => {
    // Décision de la spec §7, pas une optimisation : une recherche ciblée qui
    // restituerait les contenus permettrait de reconstituer d'un coup l'activité
    // complète d'une personne.
    const { repository } = peupler(t);

    const lignes = repository.findByTarget(MEMBRE, { limit: 50, offset: 0 });

    assert.equal(lignes.length, 3);

    for (const ligne of lignes) {
      assert.deepEqual(Object.keys(ligne), [
        'id',
        'event_type',
        'occurred_at',
        'actor_id',
        'actor_confidence',
        'target_id',
        'channel_id',
        'source',
        'audit_log_entry_id',
        'data',
      ]);

      // Contre-épreuve sur les valeurs : le contenu EST en base, il n'est
      // simplement pas rendu par cette porte.
      assert.doesNotMatch(JSON.stringify(ligne), /SECRET/);
    }
  });

  test('le contenu est bien présent en base, la restriction est côté lecture', (t) => {
    // Sans ce contrôle, le test précédent passerait aussi si l'écriture du
    // contenu avait cessé de fonctionner.
    const { rows } = peupler(t);

    assert.equal(rows('log_message_content').length, 3);
    assert.match(rows('log_message_content')[0].content_before, /SECRET/);
  });

  test('du plus récent au plus ancien, et rien qui vise un autre membre', (t) => {
    const { repository } = peupler(t);

    const lignes = repository.findByTarget(MEMBRE, { limit: 50, offset: 0 });

    assert.deepEqual(
      lignes.map((ligne) => ligne.occurred_at),
      ['2026-08-03T10:00:00.000Z', '2026-08-02T10:00:00.000Z', '2026-08-01T10:00:00.000Z'],
    );

    assert.equal(lignes.every((ligne) => ligne.target_id === MEMBRE), true);
  });

  test('respecte limite et décalage', (t) => {
    const { repository } = peupler(t);

    const page = repository.findByTarget(MEMBRE, { limit: 2, offset: 1 });

    assert.deepEqual(
      page.map((ligne) => ligne.occurred_at),
      ['2026-08-02T10:00:00.000Z', '2026-08-01T10:00:00.000Z'],
    );

    assert.deepEqual(repository.findByTarget(MEMBRE, { limit: 2, offset: 9 }), []);
  });

  test('rend une liste vide sur un membre inconnu', (t) => {
    const { repository } = peupler(t);

    assert.deepEqual(repository.findByTarget('444444444444444444', { limit: 50, offset: 0 }), []);
  });
});

describe('countByTarget', () => {
  test('compte les événements d\'un membre, zéro compris', (t) => {
    const { repository } = sandbox(t);

    assert.equal(repository.countByTarget(MEMBRE), 0);

    repository.insertEvent(event());
    repository.insertEvent(event());
    repository.insertEvent(event({ targetId: AUTRE }));

    assert.equal(repository.countByTarget(MEMBRE), 2);
    assert.equal(repository.countByTarget(AUTRE), 1);
  });
});

describe('lastEventAt', () => {
  test('rend null sur base vide', (t) => {
    // « Rien à rattraper », et non « tout rattraper » : un premier démarrage ne
    // doit pas déverser l'historique.
    const { repository } = sandbox(t);

    assert.equal(repository.lastEventAt(), null);
  });

  test('rend le plus récent, quel que soit l\'ordre d\'insertion', (t) => {
    const { repository } = sandbox(t);

    repository.insertEvent(event({ occurredAt: '2026-08-03T10:00:00.000Z' }));
    repository.insertEvent(event({ occurredAt: '2026-08-01T10:00:00.000Z' }));

    assert.equal(repository.lastEventAt(), '2026-08-03T10:00:00.000Z');
  });
});

describe('hasAuditEntry', () => {
  test('distingue une entrée connue d\'une entrée jamais vue', (t) => {
    const { repository } = sandbox(t);

    assert.equal(repository.hasAuditEntry('777'), false);

    repository.insertEvent(event({ auditLogEntryId: '777' }));

    assert.equal(repository.hasAuditEntry('777'), true);
    assert.equal(repository.hasAuditEntry('778'), false);
  });

  test('un événement sans entrée d\'audit ne rend jamais vrai', (t) => {
    // La colonne est nullable et la majorité des lignes la laissent vide :
    // `hasAuditEntry(null)` doit rester faux, sans quoi le rattrapage se
    // croirait déjà fait.
    const { repository } = sandbox(t);

    repository.insertEvent(event());

    assert.equal(repository.hasAuditEntry(null), false);
  });
});
