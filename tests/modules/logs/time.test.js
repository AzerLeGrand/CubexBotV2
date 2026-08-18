import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createDatabase } from '../../../src/core/database/index.js';
import { CORE_OWNER } from '../../../src/core/database/migrations.js';
import { createPurgeRegistry } from '../../../src/core/purge/index.js';
import { name, retention } from '../../../src/modules/logs/index.js';
import { createLogRepository } from '../../../src/modules/logs/repository.js';
import { toIsoUtc } from '../../../src/modules/logs/time.js';
import { fromRoot } from '../../../src/utils/paths.js';

/**
 * Forme des horodatages écrits en base.
 *
 * Le dernier test est le seul qui compte vraiment : il fait passer une valeur
 * produite ici par le VRAI registre de purge, celui du noyau. Une imitation
 * validerait ce qu'on lui aurait appris à valider.
 */

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('toIsoUtc', () => {
  test('rend le T, le Z et les millisecondes', () => {
    const at = toIsoUtc(new Date(Date.UTC(2026, 7, 18, 14, 32, 7, 512)));

    assert.equal(at, '2026-08-18T14:32:07.512Z');
    assert.match(at, ISO_UTC);
  });

  test('n\'insère jamais d\'espace à la place du T', () => {
    // Le piège de datetime('now') : l'espace (0x20) précède le T (0x54) en
    // binaire, et toutes les lignes du jour passeraient pour antérieures au
    // seuil de purge.
    for (const date of [new Date(0), new Date(), new Date(Date.UTC(2030, 0, 1))]) {
      assert.equal(toIsoUtc(date).charAt(10), 'T');
    }
  });

  test('rend de l\'UTC, jamais l\'heure locale', () => {
    // Une date stockée avec un décalage local devient incomparable dès que le
    // fuseau change. `bot.timezone` sert à l'affichage, jamais au stockage.
    const at = new Date(Date.UTC(2026, 11, 31, 23, 0, 0, 0));

    assert.equal(toIsoUtc(at), '2026-12-31T23:00:00.000Z');
    assert.ok(toIsoUtc(at).endsWith('Z'));
  });

  test('l\'ordre lexicographique est l\'ordre chronologique', () => {
    // C'est la propriété sur laquelle repose toute la purge : elle compare des
    // chaînes, jamais des dates.
    const tot = toIsoUtc(new Date(Date.UTC(2026, 7, 18, 9, 59, 59, 999)));
    const tard = toIsoUtc(new Date(Date.UTC(2026, 7, 18, 10, 0, 0, 0)));

    assert.equal(tot < tard, true);
  });

  test('rejette une Date invalide', () => {
    assert.throws(() => toIsoUtc(new Date('pas une date')), TypeError);
    assert.throws(() => toIsoUtc(new Date(Number.NaN)), /Date valide/);
  });

  test('rejette ce qui n\'est pas une Date', () => {
    // Accepter une chaîne déjà formatée ou un timestamp ferait exister deux
    // chemins d'écriture, donc deux formes possibles en base.
    for (const value of ['2026-08-18T14:32:07.512Z', 1_755_527_527_512, null, undefined, {}]) {
      assert.throws(() => toIsoUtc(value), TypeError, `pour ${JSON.stringify(value)}`);
    }
  });

  test('ne cite jamais la valeur reçue, seulement son type', () => {
    // Ces journaux partiront vers Discord en phase 6.
    try {
      toIsoUtc('2026-08-18T14:32:07.512Z');
      assert.fail('aurait dû lever');
    } catch (error) {
      assert.doesNotMatch(error.message, /2026-08-18/);
      assert.match(error.message, /string/);
    }
  });
});

describe('accepté par le registre de purge du noyau', () => {
  const fakeLogger = () => {
    const entries = [];
    const record = (level) => (message, context) => entries.push({ level, message, context });

    return {
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
  };

  const fakeConfig = { get: (path) => RETENTIONS[path] };

  test('une valeur produite ici passe le contrôle de format', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'cubex-logs-time-'));
    const logger = fakeLogger();
    const database = createDatabase({ file: join(root, 'test.sqlite'), logger });

    t.after(() => {
      database.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });

    database.migrate([
      { owner: CORE_OWNER, directory: fromRoot('migrations') },
      { owner: name, directory: fromRoot('src', 'modules', 'logs', 'migrations') },
    ]);

    createLogRepository({ database }).insertEvent({
      eventType: 'message_delete',
      occurredAt: toIsoUtc(new Date()),
      actorId: null,
      actorConfidence: 'unknown',
      targetId: '123456789012345678',
      channelId: '222222222222222222',
      source: 'live',
      auditLogEntryId: null,
      data: '{}',
      content: { authorId: '123456789012345678', before: 'salut', after: null, attachments: null },
    });

    const purge = createPurgeRegistry({ database, config: fakeConfig, logger });

    purge.register(name, retention);

    // Le registre lit une valeur non nulle par table et refuse de purger si la
    // forme dévie. Deux tables déclarées, deux contrôles.
    const report = purge.run();

    assert.equal(report.length, 2);
    for (const ligne of report) {
      assert.equal(ligne.error, undefined, ligne.table);
      assert.notEqual(ligne.deferred, true, `${ligne.table} : la table n'est pas vide`);
    }

    assert.equal(logger.of('error').length, 0);
  });
});
