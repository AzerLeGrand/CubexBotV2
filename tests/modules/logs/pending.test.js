import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, test } from 'node:test';

import { createPendingQueue } from '../../../src/modules/logs/pending.js';

/**
 * File d'attente des écritures différées.
 *
 * Elle diffère l'ÉCRITURE de quelques centaines de millisecondes, le temps que
 * Discord inscrive son entrée d'audit. Ce n'est pas le groupement d'affichage du
 * §5, qui viendra au lot 4 et porte sur les envois.
 */

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

describe('ordre et délai', () => {
  test('l\'ordre d\'arrivée est préservé', async () => {
    // Deux événements traités en parallèle s'insèreraient dans un ordre
    // arbitraire, et la relecture chronologique d'un incident deviendrait
    // fausse.
    const traites = [];

    const queue = createPendingQueue({
      delayMs: 0,
      onDue: async (payload) => {
        // Attente décroissante : sans sérialisation, l'ordre s'inverserait.
        await new Promise((resolve) => setTimeout(resolve, 12 - payload * 4));
        traites.push(payload);
        return payload;
      },
      logger: fakeLogger(),
    });

    await Promise.all([queue.push(1), queue.push(2), queue.push(3)]);

    assert.deepEqual(traites, [1, 2, 3]);
  });

  test('push rend ce que onDue a produit pour CET événement', async () => {
    const queue = createPendingQueue({
      delayMs: 0,
      onDue: async (payload) => ({ id: payload * 10 }),
      logger: fakeLogger(),
    });

    assert.deepEqual(await queue.push(4), { id: 40 });
  });

  test('size compte ce qui attend encore', async () => {
    const queue = createPendingQueue({
      delayMs: 50,
      onDue: async () => null,
      logger: fakeLogger(),
    });

    const attente = queue.push('a');

    assert.equal(queue.size, 1);

    await queue.flush();
    await attente;

    assert.equal(queue.size, 0);
  });

  test('le délai est relu à chaque dépôt', async () => {
    // Un `/reload` qui change write_delay_ms doit prendre effet sans
    // redémarrage : le figer au montage le rendrait sans effet.
    let delai = 0;
    const queue = createPendingQueue({
      delayMs: () => delai,
      onDue: async (payload) => payload,
      logger: fakeLogger(),
    });

    await queue.push('immediat');

    delai = 10_000;
    queue.push('lointain');

    assert.equal(queue.size, 1, 'le second attend encore');

    await queue.flush();
  });
});

describe('échec de traitement', () => {
  test('n\'empêche pas les suivants', async () => {
    const traites = [];

    const queue = createPendingQueue({
      delayMs: 0,
      onDue: async (payload) => {
        if (payload === 2) throw new Error('écriture impossible');
        traites.push(payload);
        return payload;
      },
      logger: fakeLogger(),
    });

    const resultats = await Promise.allSettled([queue.push(1), queue.push(2), queue.push(3)]);

    assert.deepEqual(traites, [1, 3], 'une ligne fautive n\'emporte pas la file');
    assert.deepEqual(
      resultats.map((held) => held.status),
      ['fulfilled', 'rejected', 'fulfilled'],
    );
  });

  test('journalise en error, sans confondre les deux faits', async () => {
    const logger = fakeLogger();

    const queue = createPendingQueue({
      delayMs: 0,
      onDue: async () => {
        throw new Error('base verrouillée');
      },
      logger,
    });

    await queue.push('x').catch(() => {});

    const [entree] = logger.of('error');

    // Ce que cette journalisation-ci apprend, c'est que la FILE a continué :
    // l'échec lui-même est relaté par onDue.
    assert.match(entree.message, /la file continue/);
    assert.equal(entree.context.error.message, 'base verrouillée');
  });

  test('la file reste utilisable après un échec', async () => {
    const queue = createPendingQueue({
      delayMs: 0,
      onDue: async (payload) => {
        if (payload === 'casse') throw new Error('non');
        return payload;
      },
      logger: fakeLogger(),
    });

    await queue.push('casse').catch(() => {});

    assert.equal(await queue.push('ok'), 'ok');
  });
});

describe('flush', () => {
  test('traite tout immédiatement, sans attendre le délai', async () => {
    const traites = [];

    const queue = createPendingQueue({
      delayMs: 60_000,
      onDue: async (payload) => {
        traites.push(payload);
        return payload;
      },
      logger: fakeLogger(),
    });

    queue.push('a');
    queue.push('b');

    await queue.flush();

    assert.deepEqual(traites, ['a', 'b']);
    assert.equal(queue.size, 0);
  });

  test('dit à onDue de ne pas corréler', async () => {
    // À l'arrêt, interroger le journal d'audit demanderait un aller-retour
    // réseau sur un client qu'on est en train de fermer. Mieux vaut un `unknown`
    // écrit qu'un événement perdu.
    const vus = [];

    const queue = createPendingQueue({
      delayMs: 60_000,
      onDue: async (payload, options) => {
        vus.push(options);
        return payload;
      },
      logger: fakeLogger(),
    });

    queue.push('a');
    await queue.flush();

    assert.deepEqual(vus, [{ correlate: false }]);
  });

  test('le traitement normal corrèle, lui', async () => {
    const vus = [];

    const queue = createPendingQueue({
      delayMs: 0,
      onDue: async (payload, options) => {
        vus.push(options);
        return payload;
      },
      logger: fakeLogger(),
    });

    await queue.push('a');

    assert.deepEqual(vus, [{ correlate: true }]);
  });

  test('sur une file vide, ne fait rien et ne lève pas', async () => {
    const queue = createPendingQueue({
      delayMs: 0,
      onDue: async () => {
        throw new Error('ne devrait pas être appelé');
      },
      logger: fakeLogger(),
    });

    await assert.doesNotReject(() => queue.flush());
  });
});

describe('minuteurs', () => {
  test('n\'empêchent pas le processus de se terminer', () => {
    // `unref()` sur le minuteur : un événement en attente ne doit jamais
    // maintenir le processus en vie, la séquence d'arrêt appelant `flush()`.
    //
    // Vérifié en sortant réellement d'un processus, seul contrôle qui prouve
    // quelque chose : un espion sur unref() se contenterait de dire qu'on l'a
    // appelé.
    const script = [
      "import { createPendingQueue } from './src/modules/logs/pending.js';",
      'const queue = createPendingQueue({',
      '  delayMs: 60000,',
      '  onDue: async () => null,',
      "  logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },",
      '});',
      "queue.push('reste en attente');",
      "process.on('exit', () => process.stdout.write('sorti'));",
    ].join('\n');

    const sortie = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    assert.equal(sortie, 'sorti', 'le processus est sorti sans attendre le minuteur');
  });
});
