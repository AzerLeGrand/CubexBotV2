import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createDatabase } from '../../../src/core/database/index.js';
import { CORE_OWNER } from '../../../src/core/database/migrations.js';
import { ACTOR_CONFIDENCE, EVENT_SOURCE } from '../../../src/modules/logs/constants.js';
import { createCorrelator } from '../../../src/modules/logs/correlation.js';
import { createLogEvent } from '../../../src/modules/logs/event.js';
import { createExclusions } from '../../../src/modules/logs/exclusions.js';
import { name } from '../../../src/modules/logs/index.js';
import { createPendingQueue } from '../../../src/modules/logs/pending.js';
import { createRecorder } from '../../../src/modules/logs/recorder.js';
import { createLogRepository } from '../../../src/modules/logs/repository.js';
import { fromRoot } from '../../../src/utils/paths.js';

/**
 * Orchestration complète : validation, activation, raccourci, file, corrélation,
 * exclusions, écriture, aiguillage.
 *
 * Les écritures sont vérifiées par un COUNT sur une base réelle, jamais par un
 * espion posé sur le dépôt : un espion prouve qu'une fonction a été appelée, pas
 * qu'une ligne existe.
 */

const BOT = '444444444444444444';
const MEMBRE = '123456789012345678';
const MODERATEUR = '111111111111111111';
const AUTRE_MOD = '333333333333333333';
const SALON = '222222222222222222';
const SALON_EXCLU = '666666666666666666';

const AT = new Date(Date.UTC(2026, 7, 18, 14, 32, 7, 512));

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

const config = (overrides = {}) => {
  const values = {
    'logs.audit.correlation_window_seconds': 5,
    'logs.exclusions.channels': [],
    'logs.exclusions.users': [],
    'logs.exclusions.roles': [],
    ...overrides,
  };

  return {
    get(path, ...fallback) {
      if (Object.hasOwn(values, path)) return values[path];
      if (fallback.length > 0) return fallback[0];

      throw new Error(`chemin de configuration inconnu : ${path}`);
    },
  };
};

const routing = {
  channelKey: 'messages',
  channelId: SALON,
  deliverable: true,
  reason: null,
};

const fakeRouter = ({ enabled = true, verdict = routing } = {}) => ({
  isEnabled: () => enabled,
  resolve: () => verdict,
});

/** Cache d'audit factice ; le vrai est éprouvé dans audit.test.js. */
const fakeCache = (entries = []) => ({
  entries: async () => entries,
  isCounted: (actionName) => actionName === 'MessageDelete',
});

const auditEntry = (patch = {}) => ({
  id: '900000000000000001',
  actionName: 'MessageDelete',
  executorId: MODERATEUR,
  targetId: MEMBRE,
  channelId: SALON,
  count: 1,
  createdAt: AT,
  isNew: true,
  increased: false,
  ...patch,
});

/**
 * Assemblage complet sur une base réelle.
 *
 * Toutes les briques sont les VRAIES, sauf le routeur et l'accès Discord : c'est
 * l'enchaînement qu'on teste ici, pas chaque pièce isolément.
 */
const harness = (t, { entries = [], reglages = {}, router = fakeRouter(), roles = {} } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'cubex-logs-rec3-'));
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

  const reglage = config(reglages);
  const repository = createLogRepository({ database });

  const correlator = createCorrelator({
    auditCache: fakeCache(entries),
    config: reglage,
    logger,
  });

  const exclusions = createExclusions({
    config: reglage,
    resolveRoles: async (userId) => roles[userId] ?? [],
    botUserId: () => BOT,
    logger,
  });

  let recorder = null;

  const pending = createPendingQueue({
    delayMs: 0,
    onDue: (event, options) => recorder.write(event, options),
    logger,
  });

  recorder = createRecorder({ repository, router, correlator, exclusions, pending, logger });

  return {
    database,
    logger,
    pending,
    recorder,
    record: recorder.record,
    count: (table) => database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
    rows: (table) => database.prepare(`SELECT * FROM ${table}`).all(),
  };
};

const input = (patch = {}) => ({
  type: 'message_delete',
  occurredAt: AT,
  actorId: null,
  actorConfidence: ACTOR_CONFIDENCE.unknown,
  targetId: MEMBRE,
  channelId: SALON,
  source: EVENT_SOURCE.live,
  ...patch,
});

describe('attribution écrite en base', () => {
  test('un événement corrélé porte probable et l\'exécuteur trouvé', async (t) => {
    const { record, rows } = harness(t, { entries: [auditEntry()] });

    const resultat = await record(input());

    const [ligne] = rows('log_events');

    assert.equal(ligne.actor_id, MODERATEUR);
    assert.equal(ligne.actor_confidence, ACTOR_CONFIDENCE.probable);
    assert.equal(resultat.event.actorConfidence, ACTOR_CONFIDENCE.probable);
  });

  test('un événement non corrélé porte unknown et actor_id null', async (t) => {
    // Discord n'inscrit rien quand un membre supprime son propre message :
    // c'est le cas le plus fréquent, pas une anomalie.
    const { record, rows } = harness(t, { entries: [] });

    await record(input());

    const [ligne] = rows('log_events');

    assert.equal(ligne.actor_id, null);
    assert.equal(ligne.actor_confidence, ACTOR_CONFIDENCE.unknown);
  });

  test('deux candidates rendent unknown jusqu\'en base', async (t) => {
    const { record, rows } = harness(t, {
      entries: [
        auditEntry({ id: 'a', executorId: MODERATEUR }),
        auditEntry({ id: 'b', executorId: AUTRE_MOD }),
      ],
    });

    await record(input());

    const [ligne] = rows('log_events');

    assert.equal(ligne.actor_id, null, 'ni l\'un ni l\'autre');
    assert.equal(ligne.actor_confidence, ACTOR_CONFIDENCE.unknown);
  });

  test('audit_log_entry_id reste null en corrélation directe', async (t) => {
    // L'index unique posé au lot 1 ne tolère pas qu'une même entrée serve deux
    // fois — et Discord incrémente une entrée existante plutôt que d'en créer
    // une par message supprimé.
    const { record, rows } = harness(t, { entries: [auditEntry({ id: '900000000000000042' })] });

    await record(input());

    assert.equal(rows('log_events')[0].audit_log_entry_id, null);
  });

  test('deux suppressions par le même modérateur ne heurtent pas l\'index', async (t) => {
    // La conséquence pratique de la décision ci-dessus : sans elle, la seconde
    // insertion échouerait et l'événement serait perdu.
    const { record, count } = harness(t, { entries: [auditEntry({ id: '900000000000000042' })] });

    await record(input());
    await record(input({ targetId: MEMBRE }));

    assert.equal(count('log_events'), 2);
  });
});

describe('exclusions', () => {
  test('un événement exclu n\'écrit RIEN', async (t) => {
    const { record, count } = harness(t, {
      reglages: { 'logs.exclusions.users': [MEMBRE] },
    });

    assert.equal(await record(input()), null);
    assert.equal(count('log_events'), 0);
    assert.equal(count('log_message_content'), 0);
  });

  test('un tiers non exclu dans un salon exclu EST écrit', async (t) => {
    // C'est tout le §4, et l'ordre corrélation-puis-exclusion en dépend.
    const { record, count, rows } = harness(t, {
      entries: [auditEntry({ channelId: SALON_EXCLU })],
      reglages: { 'logs.exclusions.channels': [SALON_EXCLU] },
    });

    const resultat = await record(input({ channelId: SALON_EXCLU }));

    assert.notEqual(resultat, null);
    assert.equal(count('log_events'), 1);
    assert.equal(rows('log_events')[0].actor_id, MODERATEUR);
  });

  test('sans auteur désigné, le salon exclu écarte', async (t) => {
    const { record, count } = harness(t, {
      entries: [],
      reglages: { 'logs.exclusions.channels': [SALON_EXCLU] },
    });

    assert.equal(await record(input({ channelId: SALON_EXCLU })), null);
    assert.equal(count('log_events'), 0);
  });

  test('une modification du bot est écartée avant même la file', async (t) => {
    const { record, count, pending } = harness(t);

    const resultat = await record(
      input({
        type: 'message_edit',
        actorId: BOT,
        actorConfidence: ACTOR_CONFIDENCE.certain,
        content: { authorId: BOT, before: 'a', after: 'b' },
      }),
    );

    assert.equal(resultat, null);
    assert.equal(pending.size, 0, 'jamais mise en file');
    assert.equal(count('log_events'), 0);
  });

  test('une SUPPRESSION d\'un message du bot par un tiers est écrite', async (t) => {
    const { record, count, rows } = harness(t, {
      entries: [auditEntry({ targetId: BOT })],
    });

    await record(input({ targetId: BOT, content: { authorId: BOT, before: 'un log' } }));

    assert.equal(count('log_events'), 1);
    assert.equal(rows('log_events')[0].actor_id, MODERATEUR);
  });
});

describe('promotion de type', () => {
  const depart = (patch = {}) =>
    input({ type: 'member_leave', channelId: null, targetId: MEMBRE, ...patch });

  const kick = (patch = {}) =>
    auditEntry({ actionName: 'MemberKick', targetId: MEMBRE, channelId: null, ...patch });

  /** Routeur qui rend un salon différent selon le type, comme le vrai. */
  const parType = (actifs = null) => ({
    isEnabled: (type) => actifs === null || actifs.includes(type),
    resolve: (type) => ({
      channelKey: type === 'member_kick' ? 'moderation' : 'members',
      channelId: type === 'member_kick' ? '777777777777777777' : '888888888888888888',
      deliverable: true,
      reason: null,
    }),
  });

  test('une candidate unique change le type ET le salon', async (t) => {
    // Les deux types ne vont pas dans le même salon : résoudre sur le type
    // d'origine enverrait toutes les expulsions dans le salon des arrivées.
    const { record, rows } = harness(t, { entries: [kick()], router: parType() });

    const resultat = await record(depart());

    assert.equal(rows('log_events')[0].event_type, 'member_kick');
    assert.equal(resultat.event.eventType, 'member_kick');
    assert.equal(resultat.routing.channelKey, 'moderation');
    assert.equal(rows('log_events')[0].actor_id, MODERATEUR);
  });

  test('deux candidates ne promeuvent pas : le départ reste un départ', async (t) => {
    // Un départ mal attribué en expulsion irait dans le salon de modération et
    // alimenterait un casier à tort.
    const { record, rows } = harness(t, {
      entries: [kick({ id: 'a' }), kick({ id: 'b', executorId: AUTRE_MOD })],
      router: parType(),
    });

    const resultat = await record(depart());

    assert.equal(rows('log_events')[0].event_type, 'member_leave');
    assert.equal(rows('log_events')[0].actor_id, null);
    assert.equal(resultat.routing.channelKey, 'members');
  });

  test('aucune candidate laisse un départ volontaire', async (t) => {
    const { record, rows } = harness(t, { entries: [], router: parType() });

    await record(depart());

    assert.equal(rows('log_events')[0].event_type, 'member_leave');
  });

  test('l\'activation est reconsultée sur le type promu', async (t) => {
    // Le staff qui coupe `member_kick` ne veut pas d'expulsions journalisées, et
    // l'événement en est une : le laisser passer sous l'étiquette `member_leave`
    // contournerait le réglage.
    const { record, count } = harness(t, {
      entries: [kick()],
      router: parType(['member_leave']),
    });

    assert.equal(await record(depart()), null);
    assert.equal(count('log_events'), 0);
  });

  test('une promotion hors table lève', async (t) => {
    // Sans ce garde-fou, un défaut du corrélateur pourrait réécrire n'importe
    // quel événement en n'importe quoi.
    const { logger } = harness(t);

    let brise = null;

    brise = createRecorder({
      repository: { insertEvent: () => 1 },
      router: parType(),
      correlator: {
        resolve: async () => ({
          actorId: MODERATEUR,
          actorConfidence: ACTOR_CONFIDENCE.probable,
          promotedType: 'member_ban',
        }),
      },
      exclusions: { isExcluded: async () => false, isBotSelfEdit: () => false },
      pending: createPendingQueue({
        delayMs: 0,
        onDue: (payload, options) => brise.write(payload, options),
        logger,
      }),
      logger,
    });

    await assert.rejects(() => brise.record(depart()), /promotion refusée/);
    await assert.rejects(() => brise.record(depart()), /TYPE_PROMOTIONS/);
  });
});

describe('salon injoignable', () => {
  test('LA LIGNE EST ÉCRITE MALGRÉ TOUT', async (t) => {
    // La garantie tenue depuis le lot 2 : l'écriture ne consulte jamais
    // `routing.deliverable`.
    const injoignable = {
      channelKey: 'messages',
      channelId: SALON,
      deliverable: false,
      reason: 'salon introuvable (logs.channels.messages)',
    };

    const { record, count, logger } = harness(t, {
      router: fakeRouter({ verdict: injoignable }),
    });

    const resultat = await record(input());

    assert.equal(count('log_events'), 1);
    assert.equal(resultat.routing.deliverable, false);
    assert.equal(resultat.routing.reason, injoignable.reason);
    assert.equal(logger.of('error').length, 0, 'un salon supprimé n\'est pas un défaut');
  });
});

describe('événement désactivé', () => {
  test('n\'écrit rien et n\'entre pas en file', async (t) => {
    const { record, count, pending, logger } = harness(t, {
      router: fakeRouter({ enabled: false }),
    });

    assert.equal(await record(input()), null);
    assert.equal(pending.size, 0);
    assert.equal(count('log_events'), 0);
    assert.deepEqual(logger.entries, []);
  });
});

describe('validation', () => {
  test('un type inconnu lève avant tout le reste', async (t) => {
    const { record, count, pending, logger } = harness(t);

    await assert.rejects(() => record(input({ type: 'type_inconnu' })), /type inconnu/);

    assert.equal(pending.size, 0);
    assert.equal(count('log_events'), 0);
    assert.equal(logger.of('error')[0].context.type, 'type_inconnu');
  });

  test('le contenu du message ne part jamais au journal', async (t) => {
    const { record, logger } = harness(t);

    await assert.rejects(() =>
      record(
        input({
          type: 'message_delete',
          content: { authorId: MEMBRE, before: 'MOT_DE_PASSE_SECRET' },
          data: { text: 'MOT_DE_PASSE_SECRET' },
        }),
      ),
    );

    assert.doesNotMatch(JSON.stringify(logger.of('error')), /MOT_DE_PASSE_SECRET/);
  });
});

describe('vidage d\'arrêt', () => {
  test('écrit sans corréler', async (t) => {
    // Un événement encore en attente quand le bot s'arrête n'existe nulle part
    // ailleurs : Discord ne le rejouera pas.
    let interroge = 0;

    const { logger, pending, recorder, count, rows } = harness(t, {
      entries: [auditEntry()],
    });

    // Recomposé avec un délai long : l'événement reste en attente.
    const differe = createPendingQueue({
      delayMs: 60_000,
      onDue: (event, options) => {
        interroge += options.correlate ? 1 : 0;
        return recorder.write(event, options);
      },
      logger,
    });

    const attente = differe.push({ input: input(), event: createLogEvent(input()) });

    assert.equal(differe.size, 1);
    assert.equal(count('log_events'), 0, 'rien n\'est encore écrit');

    await differe.flush();
    await attente;

    assert.equal(interroge, 0, 'la corrélation n\'a pas été demandée');
    assert.equal(count('log_events'), 1);

    const [ligne] = rows('log_events');

    // Mieux vaut un `unknown` écrit qu'un événement perdu.
    assert.equal(ligne.actor_id, null);
    assert.equal(ligne.actor_confidence, ACTOR_CONFIDENCE.unknown);
    assert.equal(pending.size, 0);
  });

  test('conserve un acteur que la plateforme désignait déjà', async (t) => {
    // Sans corrélation ne veut pas dire sans auteur : `certain` vient de
    // l'appelant et survit au vidage.
    const { logger, recorder, rows } = harness(t);

    const differe = createPendingQueue({
      delayMs: 60_000,
      onDue: (event, options) => recorder.write(event, options),
      logger,
    });

    const arrivee = input({
      type: 'member_join',
      actorId: MEMBRE,
      actorConfidence: ACTOR_CONFIDENCE.certain,
      channelId: null,
    });

    const attente = differe.push({ input: arrivee, event: createLogEvent(arrivee) });

    await differe.flush();
    await attente;

    const [ligne] = rows('log_events');

    assert.equal(ligne.actor_id, MEMBRE);
    assert.equal(ligne.actor_confidence, ACTOR_CONFIDENCE.certain);
  });
});

describe('écriture impossible', () => {
  test('journalise en error et relance', async (t) => {
    const { logger } = harness(t);
    const casse = {
      insertEvent: () => {
        throw new Error('database is locked');
      },
    };

    const brise = createRecorder({
      repository: casse,
      router: fakeRouter(),
      correlator: { resolve: async () => ({ actorId: null, actorConfidence: ACTOR_CONFIDENCE.unknown }) },
      exclusions: { isExcluded: async () => false, isBotSelfEdit: () => false },
      pending: createPendingQueue({
        delayMs: 0,
        onDue: (event, options) => brise.write(event, options),
        logger,
      }),
      logger,
    });

    await assert.rejects(() => brise.record(input()), /database is locked/);

    const [entree] = logger.of('error');

    assert.match(entree.message, /écriture d'un événement/);
    assert.equal(entree.context.type, 'message_delete');

    // Et le second fait, distinct : la file a continué malgré l'échec.
    assert.equal(logger.of('error').length, 2);
    assert.match(logger.of('error')[1].message, /la file continue/);
  });
});

describe('valeur de retour', () => {
  test('rend id, event et routing quand la ligne est écrite', async (t) => {
    const { record, rows } = harness(t, { entries: [auditEntry()] });

    const resultat = await record(input());

    assert.deepEqual(Object.keys(resultat).sort(), ['event', 'id', 'routing']);
    assert.equal(resultat.id, rows('log_events')[0].id);
    assert.equal(resultat.event.occurredAt, '2026-08-18T14:32:07.512Z');
  });

  test('écrit le contenu du message avec ses métadonnées', async (t) => {
    const { record, rows } = harness(t, { entries: [] });

    await record(input({ content: { authorId: MEMBRE, before: 'salut' } }));

    const [contenu] = rows('log_message_content');

    assert.equal(contenu.author_id, MEMBRE);
    assert.equal(contenu.content_before, 'salut');
  });
});
