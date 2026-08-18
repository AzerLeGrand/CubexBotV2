import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createDatabase } from '../../../src/core/database/index.js';
import { CORE_OWNER } from '../../../src/core/database/migrations.js';
import { ACTOR_CONFIDENCE, EVENT_SOURCE } from '../../../src/modules/logs/constants.js';
import { name } from '../../../src/modules/logs/index.js';
import { createRecorder } from '../../../src/modules/logs/recorder.js';
import { createLogRepository } from '../../../src/modules/logs/repository.js';
import { fromRoot } from '../../../src/utils/paths.js';

/**
 * Orchestration : activation, normalisation, écriture, aiguillage.
 *
 * Le test central du lot est « écrit en base malgré un salon injoignable ». Tout
 * le reste du module en découle : l'écriture est immédiate et indépendante de
 * l'affichage, et un incident d'envoi ne doit jamais faire perdre la donnée.
 *
 * Les écritures sont vérifiées par un COUNT sur une base réelle, jamais par un
 * espion posé sur le dépôt : un espion prouve qu'une fonction a été appelée, pas
 * qu'une ligne existe.
 */

const MEMBRE = '123456789012345678';
const MODERATEUR = '987654321098765432';
const SALON = '222222222222222222';

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

/** Routeur factice : le vrai est éprouvé dans router.test.js. */
const fakeRouter = ({ enabled = true, routing = null } = {}) => ({
  isEnabled: () => enabled,
  resolve: (type) =>
    routing ?? {
      channelKey: 'moderation',
      channelId: SALON,
      deliverable: true,
      reason: null,
      type,
    },
});

const sandbox = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cubex-logs-rec-'));
  const logger = fakeLogger();
  const database = createDatabase({ file: join(root, 'test.sqlite'), logger: fakeLogger() });

  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  database.migrate([
    { owner: CORE_OWNER, directory: fromRoot('migrations') },
    { owner: name, directory: fromRoot('src', 'modules', 'logs', 'migrations') },
  ]);

  const repository = createLogRepository({ database });

  return {
    database,
    logger,
    repository,
    count: (table) => database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
    rows: (table) => database.prepare(`SELECT * FROM ${table}`).all(),
  };
};

const input = (patch = {}) => ({
  type: 'member_ban',
  occurredAt: new Date(Date.UTC(2026, 7, 18, 14, 32, 7, 512)),
  actorId: MODERATEUR,
  actorConfidence: ACTOR_CONFIDENCE.certain,
  targetId: MEMBRE,
  channelId: null,
  source: EVENT_SOURCE.live,
  ...patch,
});

describe('événement désactivé', () => {
  test('n\'écrit rien du tout', (t) => {
    // Conserver quatre-vingt-dix jours une donnée dont personne n'a demandé la
    // journalisation serait une collecte sans finalité.
    const { repository, logger, count } = sandbox(t);
    const record = createRecorder({
      repository,
      router: fakeRouter({ enabled: false }),
      logger,
    });

    assert.equal(record(input()), null);

    assert.equal(count('log_events'), 0);
    assert.equal(count('log_message_content'), 0);
  });

  test('ne journalise rien non plus', (t) => {
    // Un événement coupé peut être le plus fréquent du serveur : le signaler
    // noierait le fichier de journal.
    const { repository, logger } = sandbox(t);
    const record = createRecorder({ repository, router: fakeRouter({ enabled: false }), logger });

    record(input());

    assert.deepEqual(logger.entries, []);
  });

  test('un événement invalide lève même s\'il est coupé', (t) => {
    // Conséquence assumée de l'ordre : la validation précède la porte de sortie.
    // Un type inconnu reste un défaut de programmation, que la configuration
    // l'ait écarté ou non — et le taire ferait dépendre le signalement d'un
    // réglage sans rapport.
    const { repository, logger, count } = sandbox(t);
    const record = createRecorder({ repository, router: fakeRouter({ enabled: false }), logger });

    assert.throws(() => record(input({ type: 'type_inconnu' })), /type inconnu/);
    assert.equal(count('log_events'), 0);
  });
});

describe('ordre des étapes', () => {
  /** Routeur qui se signale bruyamment s'il est consulté. */
  const bavard = () => {
    const appels = [];

    return {
      appels,
      isEnabled: (type) => {
        appels.push(['isEnabled', type]);
        throw new Error(`chemin de configuration inconnu : logs.events.${type}.enabled`);
      },
      resolve: (type) => {
        appels.push(['resolve', type]);
        throw new Error('le routeur ne doit pas être consulté ici');
      },
    };
  };

  test('un type inconnu lève depuis la normalisation, jamais depuis le routeur', (t) => {
    // C'est la garantie de record() : `isEnabled()` lève sur un chemin de
    // configuration absent, et l'enveloppe d'événements du noyau ne relance pas.
    // Si le routeur passait en premier, un type mal orthographié ferait tomber
    // un écouteur entier sans qu'aucune ligne n'atteigne la base.
    const { repository, logger, count } = sandbox(t);
    const router = bavard();

    try {
      createRecorder({ repository, router, logger })(input({ type: 'type_inconnu' }));
      assert.fail('aurait dû lever');
    } catch (error) {
      assert.match(error.message, /type inconnu/, 'l\'origine est createLogEvent');
      assert.doesNotMatch(error.message, /chemin de configuration/, 'et non le routeur');
    }

    assert.deepEqual(router.appels, [], 'le routeur n\'a pas été consulté du tout');
    assert.equal(count('log_events'), 0);
  });

  test('l\'activation est consultée sur le type normalisé', (t) => {
    // `createLogEvent()` renomme `type` en `eventType`, comme la colonne : le
    // recorder doit interroger le second, sinon `isEnabled(undefined)` lèverait
    // sur un chemin absurde.
    const { repository, logger } = sandbox(t);
    const vus = [];

    const router = {
      isEnabled: (type) => {
        vus.push(type);
        return true;
      },
      resolve: (type) => {
        vus.push(type);
        return { channelKey: 'moderation', channelId: SALON, deliverable: true, reason: null };
      },
    };

    createRecorder({ repository, router, logger })(input());

    assert.deepEqual(vus, ['member_ban', 'member_ban']);
  });
});

describe('salon injoignable', () => {
  const injoignable = {
    channelKey: 'moderation',
    channelId: SALON,
    deliverable: false,
    reason: 'salon introuvable (logs.channels.moderation)',
  };

  test('LA LIGNE EST ÉCRITE EN BASE MALGRÉ TOUT', (t) => {
    // Le test le plus important du lot. L'écriture ne consulte jamais
    // `deliverable` : un salon supprimé ne doit pas faire perdre l'historique.
    const { repository, logger, count, rows } = sandbox(t);
    const record = createRecorder({
      repository,
      router: fakeRouter({ routing: injoignable }),
      logger,
    });

    const result = record(input());

    assert.equal(count('log_events'), 1);
    assert.equal(rows('log_events')[0].event_type, 'member_ban');
    assert.equal(result.routing.deliverable, false);
    assert.equal(result.routing.reason, injoignable.reason);
  });

  test('rend quand même l\'identifiant inséré', (t) => {
    const { repository, logger, rows } = sandbox(t);
    const record = createRecorder({
      repository,
      router: fakeRouter({ routing: injoignable }),
      logger,
    });

    const { id } = record(input());

    assert.equal(typeof id, 'number');
    assert.equal(rows('log_events')[0].id, id);
  });

  test('n\'émet aucune erreur : ce n\'est pas un défaut', (t) => {
    const { repository, logger } = sandbox(t);
    const record = createRecorder({
      repository,
      router: fakeRouter({ routing: injoignable }),
      logger,
    });

    record(input());

    assert.equal(logger.of('error').length, 0);
  });
});

describe('cas nominal', () => {
  test('rend id, event et routing', (t) => {
    const { repository, logger } = sandbox(t);
    const record = createRecorder({ repository, router: fakeRouter(), logger });

    const result = record(input());

    assert.deepEqual(Object.keys(result).sort(), ['event', 'id', 'routing']);
    assert.equal(result.event.eventType, 'member_ban');
    assert.equal(result.event.occurredAt, '2026-08-18T14:32:07.512Z');
    assert.equal(result.routing.deliverable, true);
  });

  test('écrit le contenu quand il y en a un', (t) => {
    const { repository, logger, count, rows } = sandbox(t);
    const record = createRecorder({ repository, router: fakeRouter(), logger });

    record(
      input({
        type: 'message_delete',
        actorId: null,
        actorConfidence: ACTOR_CONFIDENCE.unknown,
        channelId: SALON,
        content: { authorId: MEMBRE, before: 'salut', attachments: [{ name: 'a.png' }] },
      }),
    );

    assert.equal(count('log_message_content'), 1);

    const [contenu] = rows('log_message_content');

    assert.equal(contenu.author_id, MEMBRE);
    assert.equal(contenu.content_before, 'salut');
    assert.deepEqual(JSON.parse(contenu.attachments), [{ name: 'a.png' }]);
  });

  test('data est relisible en base, jamais doublement sérialisé', (t) => {
    // Le piège que la sortie « déjà sérialisée » ferme : JSON.stringify appliqué
    // deux fois produit une chaîne échappée, relue comme du texte.
    const { repository, logger, rows } = sandbox(t);
    const record = createRecorder({ repository, router: fakeRouter(), logger });

    record(input({ data: { reason: 'spam' } }));

    assert.deepEqual(JSON.parse(rows('log_events')[0].data), { reason: 'spam' });
  });

  test('n\'écrit aucune ligne de journal quand tout se passe bien', (t) => {
    const { repository, logger } = sandbox(t);

    createRecorder({ repository, router: fakeRouter(), logger })(input());

    assert.deepEqual(logger.entries, []);
  });
});

describe('événement invalide', () => {
  test('journalise en error et relance', (t) => {
    const { repository, logger, count } = sandbox(t);
    const record = createRecorder({ repository, router: fakeRouter(), logger });

    assert.throws(() => record(input({ type: 'type_inconnu' })), /type inconnu/);

    const [entree] = logger.of('error');

    assert.equal(entree.message, 'événement de journalisation invalide');
    assert.equal(entree.context.type, 'type_inconnu');
    assert.equal(count('log_events'), 0, 'rien n\'est écrit');
  });

  test('ne fait jamais partir le contenu du message au journal', (t) => {
    // Ces journaux partiront vers Discord en phase 6 : seul le type est cité.
    const { repository, logger } = sandbox(t);
    const record = createRecorder({ repository, router: fakeRouter(), logger });

    assert.throws(() =>
      record(
        input({
          type: 'message_delete',
          actorId: null,
          actorConfidence: ACTOR_CONFIDENCE.unknown,
          content: { authorId: MEMBRE, before: 'MOT_DE_PASSE_SECRET' },
          data: { text: 'MOT_DE_PASSE_SECRET' },
        }),
      ),
    );

    assert.doesNotMatch(JSON.stringify(logger.of('error')), /MOT_DE_PASSE_SECRET/);
  });
});

describe('écriture impossible', () => {
  const cassé = { insertEvent: () => { throw new Error('database is locked'); } };

  test('journalise en error et relance', (t) => {
    // Perdre un événement en silence est le pire défaut possible : la donnée
    // n'existe nulle part ailleurs et Discord ne la rejoue pas.
    const { logger } = sandbox(t);
    const record = createRecorder({ repository: cassé, router: fakeRouter(), logger });

    assert.throws(() => record(input()), /database is locked/);

    const [entree] = logger.of('error');

    assert.equal(entree.message, 'écriture d\'un événement de journalisation impossible');
    assert.equal(entree.context.type, 'member_ban');
    assert.equal(entree.context.error.message, 'database is locked');
  });

  test('n\'interroge pas l\'aiguillage sur un événement non écrit', (t) => {
    const { logger } = sandbox(t);

    let resolved = 0;
    const router = { isEnabled: () => true, resolve: () => (resolved += 1) };

    assert.throws(() => createRecorder({ repository: cassé, router, logger })(input()));

    assert.equal(resolved, 0);
  });
});
