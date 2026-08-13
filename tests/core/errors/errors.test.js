import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';

import {
  AppError,
  FeatureUnavailableError,
  installGlobalHandlers,
  isExpected,
  PermissionDeniedError,
  toError,
} from '../../../src/core/errors/index.js';

describe('AppError', () => {
  test('sépare le message technique du gabarit destiné à l\'utilisateur', () => {
    const error = new AppError('échec de l\'appel à l\'API', {
      code: 'discord_call_failed',
      template: 'feature_unavailable',
      variables: { username: 'Azer' },
      context: { channel: '123' },
    });

    assert.equal(error.message, 'échec de l\'appel à l\'API');
    assert.equal(error.template, 'feature_unavailable');
    assert.deepEqual(error.variables, { username: 'Azer' });
    assert.deepEqual(error.toLog(), {
      code: 'discord_call_failed',
      expected: true,
      channel: '123',
    });
  });

  test('reste une Error, avec un nom et une pile', () => {
    const error = new AppError('anomalie');

    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AppError');
    assert.match(error.stack, /AppError: anomalie/);
    // La pile commence chez l'appelant, pas dans le constructeur.
    assert.doesNotMatch(error.stack.split('\n')[1], /app-error\.js/);
  });

  test('conserve la cause', () => {
    const cause = new Error('socket fermée');
    const error = new AppError('envoi impossible', { cause });

    assert.equal(error.cause, cause);
  });

  test('n\'invente pas de cause quand aucune n\'est donnée', () => {
    assert.equal('cause' in new AppError('anomalie'), false);
  });
});

describe('erreurs spécialisées', () => {
  test('PermissionDeniedError porte le gabarit de refus', () => {
    const error = new PermissionDeniedError('ban', { userId: '123' });

    assert.equal(error.name, 'PermissionDeniedError');
    assert.equal(error.code, 'permission_denied');
    assert.equal(error.template, 'command_denied');
    assert.match(error.message, /ban/);
    assert.deepEqual(error.toLog(), {
      code: 'permission_denied',
      expected: true,
      command: 'ban',
      userId: '123',
    });
  });

  test('FeatureUnavailableError nomme la capacité concernée', () => {
    const error = new FeatureUnavailableError('tickets.category.game', {
      reason: 'salon introuvable',
    });

    assert.equal(error.code, 'feature_unavailable');
    assert.equal(error.template, 'feature_unavailable');
    assert.equal(error.toLog().capability, 'tickets.category.game');
  });
});

describe('isExpected', () => {
  test('distingue une erreur prévue d\'un défaut du code', () => {
    assert.equal(isExpected(new PermissionDeniedError('ban')), true);
    assert.equal(isExpected(new AppError('anomalie', { expected: false })), false);
    assert.equal(isExpected(new TypeError('x is not a function')), false);
    assert.equal(isExpected('chaîne jetée'), false);
  });
});

describe('toError', () => {
  test('laisse passer une Error', () => {
    const error = new Error('déjà une erreur');

    assert.equal(toError(error), error);
  });

  test('enveloppe une valeur rejetée qui n\'est pas une Error', () => {
    // Une promesse peut rejeter n'importe quoi, y compris undefined.
    for (const valeur of ['échec', 42, null, undefined, { code: 'x' }]) {
      const error = toError(valeur);

      assert.ok(error instanceof Error);
      assert.match(error.message, /rejet non-Error/);
      assert.equal(error.cause, valeur);
    }
  });

  test('survit à une valeur non sérialisable', () => {
    const circulaire = {};
    circulaire.self = circulaire;

    assert.ok(toError(circulaire) instanceof Error);
  });
});

describe('installGlobalHandlers', () => {
  /** Cible et journal factices : rien n'est posé sur le vrai process. */
  const harness = ({ drain, drainTimeoutMs } = {}) => {
    const target = new EventEmitter();
    const entries = [];
    const exits = [];

    const logger = {
      error: (message, context) => entries.push({ message, context }),
      warn: () => {},
      info: () => {},
      debug: () => {},
      close: () => Promise.resolve(),
    };

    const uninstall = installGlobalHandlers({
      logger,
      target,
      exit: (code) => exits.push(code),
      drain: drain ?? (() => logger.close()),
      drainTimeoutMs,
    });

    return { target, entries, exits, uninstall, logger };
  };

  test('journalise puis sort sur une exception non capturée', async () => {
    const { target, entries, exits } = harness();

    target.emit('uncaughtException', new Error('effondrement'));
    await wait(20);

    assert.equal(entries.length, 1);
    assert.match(entries[0].message, /uncaughtException/);
    assert.equal(entries[0].context.error.message, 'effondrement');
    assert.deepEqual(exits, [1]);
  });

  test('traite un rejet non capturé de la même façon', async () => {
    const { target, entries, exits } = harness();

    target.emit('unhandledRejection', new Error('promesse abandonnée'));
    await wait(20);

    assert.match(entries[0].message, /unhandledRejection/);
    assert.deepEqual(exits, [1]);
  });

  test('enveloppe un rejet qui n\'est pas une Error', async () => {
    const { target, entries, exits } = harness();

    target.emit('unhandledRejection', 'juste une chaîne');
    await wait(20);

    assert.ok(entries[0].context.error instanceof Error);
    assert.deepEqual(exits, [1]);
  });

  test('attend le drain avant de sortir', async () => {
    const ordre = [];
    const { target, exits } = harness({
      drain: async () => {
        await wait(30);
        ordre.push('drain');
      },
    });

    target.emit('uncaughtException', new Error('effondrement'));

    // Le drain n'est pas fini : rien ne doit être sorti.
    await wait(10);
    assert.deepEqual(exits, []);

    await wait(50);
    assert.deepEqual(ordre, ['drain']);
    assert.deepEqual(exits, [1]);
  });

  test('sort quand même si le drain reste bloqué', async () => {
    // Disque plein, transport figé : le redémarrage ne doit pas en dépendre.
    const { target, exits } = harness({ drain: () => new Promise(() => {}), drainTimeoutMs: 30 });

    target.emit('uncaughtException', new Error('effondrement'));

    await wait(10);
    assert.deepEqual(exits, []);

    await wait(60);
    assert.deepEqual(exits, [1]);
  });

  test('sort même si le drain échoue', async () => {
    const { target, exits } = harness({ drain: () => Promise.reject(new Error('drain cassé')) });

    target.emit('uncaughtException', new Error('effondrement'));
    await wait(20);

    assert.deepEqual(exits, [1]);
  });

  test('une seconde secousse pendant l\'arrêt ne relance pas la séquence', async () => {
    const { target, entries, exits } = harness({
      drain: async () => {
        await wait(30);
      },
    });

    target.emit('uncaughtException', new Error('première'));
    target.emit('unhandledRejection', new Error('seconde'));
    target.emit('uncaughtException', new Error('troisième'));

    await wait(60);

    assert.equal(entries.length, 1, 'une seule entrée, celle qui explique l\'arrêt');
    assert.deepEqual(exits, [1], 'une seule sortie');
  });

  test('retire ses écouteurs quand on le lui demande', () => {
    const { target, uninstall, exits } = harness();

    uninstall();
    target.emit('uncaughtException', new Error('ignorée'));

    assert.deepEqual(exits, []);
    assert.equal(target.listenerCount('uncaughtException'), 0);
    assert.equal(target.listenerCount('unhandledRejection'), 0);
  });
});
