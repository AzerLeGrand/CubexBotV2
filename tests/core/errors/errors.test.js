import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';

import {
  AppError,
  createShutdown,
  FeatureUnavailableError,
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

describe('createShutdown', () => {
  /** Cible et journal factices : rien n'est posé sur le vrai process. */
  const harness = ({ close, stepTimeoutMs, diagnostic, stderr } = {}) => {
    const target = new EventEmitter();
    const entries = [];
    const exits = [];
    const ordre = [];
    const diagnostics = [];

    const record = (level) => (message, context) => entries.push({ level, message, context });

    const logger = {
      error: record('error'),
      warn: record('warn'),
      info: record('info'),
      debug: record('debug'),
      close:
        close ??
        (() => {
          ordre.push('logging');
          return Promise.resolve();
        }),
    };

    const shutdown = createShutdown({
      logger,
      target,
      exit: (code) => exits.push(code),
      stepTimeoutMs,
      diagnostic,
      // Rien n'est écrit sur le vrai stderr : la sortie est retenue, et son
      // ordre par rapport aux étapes de fermeture est observable.
      stderr:
        stderr ??
        ((text) => {
          ordre.push('stderr');
          diagnostics.push(text);
        }),
    });

    const uninstall = shutdown.install();

    return { target, entries, exits, ordre, diagnostics, uninstall, shutdown, logger };
  };

  const of = (entries, level) => entries.filter((entry) => entry.level === level);

  describe('signaux — arrêt normal', () => {
    for (const signal of ['SIGTERM', 'SIGINT']) {
      test(`${signal} sort avec le code 0 et journalise en info`, async () => {
        const { target, entries, exits } = harness();

        target.emit(signal);
        await wait(20);

        assert.deepEqual(exits, [0], 'un arrêt demandé n\'est pas un échec');
        assert.equal(of(entries, 'error').length, 0, 'aucune alerte à chaque déploiement');

        const [entrée] = of(entries, 'info');
        assert.match(entrée.message, new RegExp(signal));
        assert.equal(entrée.context.signal, signal);
      });
    }
  });

  describe('défaillances — arrêt anormal', () => {
    test('une exception non capturée sort avec le code 1 et journalise en error', async () => {
      const { target, entries, exits } = harness();

      target.emit('uncaughtException', new Error('effondrement'));
      await wait(20);

      assert.deepEqual(exits, [1]);

      const [entrée] = of(entries, 'error');
      assert.match(entrée.message, /uncaughtException/);
      assert.equal(entrée.context.error.message, 'effondrement');
    });

    test('un rejet non capturé est traité de la même façon', async () => {
      const { target, entries, exits } = harness();

      target.emit('unhandledRejection', new Error('promesse abandonnée'));
      await wait(20);

      assert.match(of(entries, 'error')[0].message, /unhandledRejection/);
      assert.deepEqual(exits, [1]);
    });

    test('un rejet qui n\'est pas une Error est enveloppé', async () => {
      const { target, entries, exits } = harness();

      target.emit('unhandledRejection', 'juste une chaîne');
      await wait(20);

      assert.ok(of(entries, 'error')[0].context.error instanceof Error);
      assert.deepEqual(exits, [1]);
    });
  });

  describe('diagnostic sur stderr', () => {
    test('le chemin fatal écrit un résumé', async () => {
      // Hors développement, le journal n'écrit qu'en fichier JSON : sans ce
      // résumé, `pm2 logs` ne montrerait rien d'un processus qui sort en 1.
      const { target, diagnostics } = harness();

      target.emit('uncaughtException', new Error('effondrement'));
      await wait(20);

      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0], /uncaughtException/);
      assert.match(diagnostics[0], /Error: effondrement/);
      assert.match(diagnostics[0], /at /, 'la pile permet de diagnostiquer sans ouvrir un fichier');
    });

    test('un rejet non capturé est résumé de la même façon', async () => {
      const { target, diagnostics } = harness();

      target.emit('unhandledRejection', new Error('promesse abandonnée'));
      await wait(20);

      assert.match(diagnostics[0], /unhandledRejection/);
      assert.match(diagnostics[0], /promesse abandonnée/);
    });

    test('un signal n\'écrit rien : c\'est un arrêt normal', async () => {
      const { target, diagnostics } = harness();

      target.emit('SIGTERM');
      await wait(20);

      assert.deepEqual(diagnostics, []);
    });

    test('le résumé part AVANT la première étape de fermeture', async () => {
      const { target, ordre, shutdown } = harness();

      shutdown.register('database', () => ordre.push('database'));
      target.emit('uncaughtException', new Error('effondrement'));
      await wait(20);

      // Une étape bloquée retarde de plusieurs secondes, et le drain peut ne
      // jamais aboutir : le diagnostic ne doit dépendre d'aucun transport.
      assert.deepEqual(ordre, ['stderr', 'database', 'logging']);
    });

    test('porte la cause, que le journal ne sérialise pas', async () => {
      const { target, diagnostics } = harness();
      const error = new Error('connexion refusée', { cause: new TypeError('jeton absent') });

      target.emit('uncaughtException', error);
      await wait(20);

      assert.match(diagnostics[0], /cause : TypeError: jeton absent/);
    });

    test('console déjà branchée : aucun doublon', async () => {
      // La condition est tranchée par l'appelant et injectée : handler.js ne
      // lit pas l'environnement.
      const { target, diagnostics, exits } = harness({ diagnostic: false });

      target.emit('uncaughtException', new Error('effondrement'));
      await wait(20);

      assert.deepEqual(diagnostics, []);
      assert.deepEqual(exits, [1], 'la séquence se déroule quand même');
    });

    test('une écriture qui lève ne fait pas échouer l\'arrêt', async () => {
      const { target, ordre, exits } = harness({
        stderr: () => {
          throw new Error('descripteur ferme');
        },
      });

      target.emit('uncaughtException', new Error('effondrement'));
      await wait(20);

      assert.deepEqual(ordre, ['logging'], 'la fermeture se déroule');
      assert.deepEqual(exits, [1]);
    });

    test('une seconde secousse ne produit pas un second résumé', async () => {
      const { target, diagnostics } = harness();

      target.emit('uncaughtException', new Error('premier'));
      target.emit('uncaughtException', new Error('second'));
      await wait(20);

      // La séquence ne se relance pas ; le résumé non plus, sans quoi le
      // premier motif -- le vrai -- serait noyé.
      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0], /premier/);
    });

    test('tient sans contexte, run() étant appelable directement', async () => {
      const { shutdown, diagnostics } = harness();

      await shutdown.run({ reason: 'appel direct', code: 1, level: 'error' });

      assert.equal(diagnostics.length, 1);
      assert.match(diagnostics[0], /appel direct/);
    });
  });

  describe('séquence de fermeture', () => {
    test('ferme dans l\'ordre inverse de l\'inscription, journaux en dernier', async () => {
      const { target, ordre, shutdown } = harness();

      shutdown.register('database', () => ordre.push('database'));
      shutdown.register('discord', () => ordre.push('discord'));

      target.emit('SIGTERM');
      await wait(20);

      // On ferme comme on a ouvert, à l'envers. Le journal, inscrit d'office en
      // premier, part en dernier et peut relater les fermetures précédentes.
      assert.deepEqual(ordre, ['discord', 'database', 'logging']);
    });

    test('attend chaque étape avant de sortir', async () => {
      const { target, exits, ordre, shutdown } = harness();

      shutdown.register('database', async () => {
        await wait(40);
        ordre.push('database');
      });

      target.emit('SIGTERM');

      await wait(15);
      assert.deepEqual(exits, [], 'la fermeture est en cours');

      await wait(60);
      assert.deepEqual(ordre, ['database', 'logging']);
      assert.deepEqual(exits, [0]);
    });

    test('une étape bloquée n\'empêche pas les suivantes ni la sortie', async () => {
      // Disque plein, socket qui ne répond plus : le redémarrage ne doit pas
      // en dépendre.
      const { target, entries, exits, ordre, shutdown } = harness({ stepTimeoutMs: 30 });

      shutdown.register('discord', () => new Promise(() => {}));

      target.emit('SIGTERM');
      await wait(80);

      assert.deepEqual(ordre, ['logging'], 'le drain a bien eu lieu malgré le blocage');
      assert.deepEqual(exits, [0]);
      assert.match(of(entries, 'warn')[0].message, /fermeture incomplète : discord/);
      assert.match(of(entries, 'warn')[0].context.reason, /délai de 30 ms/);
    });

    test('une étape en échec n\'empêche pas les suivantes', async () => {
      const { target, entries, exits, ordre, shutdown } = harness();

      shutdown.register('database', () => {
        throw new Error('checkpoint refusé');
      });

      target.emit('SIGTERM');
      await wait(20);

      assert.deepEqual(ordre, ['logging']);
      assert.deepEqual(exits, [0]);
      assert.equal(of(entries, 'warn')[0].context.reason, 'checkpoint refusé');
    });

    test('permet de retirer une étape inscrite', async () => {
      const { target, ordre, shutdown } = harness();

      const retirer = shutdown.register('database', () => ordre.push('database'));
      retirer();

      target.emit('SIGTERM');
      await wait(20);

      assert.deepEqual(ordre, ['logging']);
    });

    test('ne laisse pas retirer le drain des journaux', async () => {
      const { target, ordre, shutdown } = harness();

      // Le nom est réservé : une étape homonyme ne doit pas pouvoir désinscrire
      // le drain, sans quoi l'entrée expliquant l'arrêt serait perdue.
      shutdown.register('logging', () => {})();

      target.emit('SIGTERM');
      await wait(20);

      assert.deepEqual(ordre, ['logging']);
    });
  });

  describe('robustesse', () => {
    test('une seconde secousse pendant l\'arrêt ne relance pas la séquence', async () => {
      const { target, entries, exits, shutdown } = harness();

      shutdown.register('database', async () => {
        await wait(30);
      });

      target.emit('uncaughtException', new Error('première'));
      target.emit('unhandledRejection', new Error('seconde'));
      target.emit('SIGTERM');

      await wait(60);

      assert.equal(of(entries, 'error').length, 1, 'une seule entrée expliquant l\'arrêt');
      assert.deepEqual(exits, [1], 'une seule sortie, celle du premier déclencheur');
    });

    test('retire tous ses écouteurs quand on le lui demande', () => {
      const { target, uninstall, exits } = harness();

      uninstall();

      for (const event of ['SIGTERM', 'SIGINT', 'uncaughtException', 'unhandledRejection']) {
        target.emit(event, new Error('ignorée'));
        assert.equal(target.listenerCount(event), 0, `${event} encore écouté`);
      }

      assert.deepEqual(exits, []);
    });
  });
});
