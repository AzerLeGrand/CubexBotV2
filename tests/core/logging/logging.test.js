import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';

import { createLogger } from '../../../src/core/logging/index.js';
import { RotatingFileTransport } from '../../../src/core/logging/rotating-file.js';
import { tempDir } from '../../helpers/fixtures.js';

const TIMEZONE = 'Europe/Paris';

const today = (offsetDays = 0) =>
  new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: TIMEZONE,
  }).format(new Date(Date.now() + offsetDays * 86_400_000));

const options = (dir, overrides = {}) => ({
  level: 'debug',
  directory: join(dir, 'logs'),
  filePrefix: 'cubex',
  retentionDays: 30,
  timezone: TIMEZONE,
  ...overrides,
});

/** Laisse au flux le temps d'écrire : createWriteStream est asynchrone. */
const flush = () => wait(60);

describe('RotatingFileTransport', () => {
  const transport = (dir, overrides = {}) =>
    new RotatingFileTransport({
      directory: join(dir, 'logs'),
      prefix: 'cubex',
      retentionDays: 30,
      timezone: TIMEZONE,
      ...overrides,
    });

  test('crée le dossier des journaux s\'il manque', (t) => {
    const dir = tempDir(t);

    transport(dir).close();

    assert.deepEqual(readdirSync(join(dir, 'logs')), []);
  });

  test('supprime les fichiers dépassant la rétention', (t) => {
    const dir = tempDir(t);
    const logs = join(dir, 'logs');

    // Le transport est construit AVANT que les fichiers n'existent : son
    // balayage de construction ne doit pas être ce que ce test mesure.
    const t1 = transport(dir);

    const anciens = [`cubex-${today(-40)}.log`, `cubex-${today(-31)}.log`];
    const gardés = [`cubex-${today(-30)}.log`, `cubex-${today(-1)}.log`, `cubex-${today()}.log`];

    for (const nom of [...anciens, ...gardés]) writeFileSync(join(logs, nom), 'x', 'utf8');

    const { deleted, failed } = t1.sweep();
    t1.close();

    assert.equal(deleted, 2);
    assert.equal(failed, 0);
    assert.deepEqual(readdirSync(logs).sort(), [...gardés].sort());
  });

  test('conserve exactement le fichier du dernier jour retenu', (t) => {
    // La frontière : à 30 jours de rétention, le fichier daté de J-30 reste.
    const dir = tempDir(t);
    const t1 = transport(dir);

    writeFileSync(join(dir, 'logs', `cubex-${today(-30)}.log`), 'x', 'utf8');
    writeFileSync(join(dir, 'logs', `cubex-${today(-31)}.log`), 'x', 'utf8');

    assert.equal(t1.sweep().deleted, 1);
    t1.close();

    assert.deepEqual(readdirSync(join(dir, 'logs')), [`cubex-${today(-30)}.log`]);
  });

  test('ne touche pas aux fichiers qui ne suivent pas le motif', (t) => {
    const dir = tempDir(t);
    const logs = join(dir, 'logs');
    mkdirSync(logs, { recursive: true });

    const intrus = ['notes.txt', `autre-${today(-90)}.log`, 'cubex.log', `cubex-${today(-90)}.txt`];
    for (const nom of intrus) writeFileSync(join(logs, nom), 'x', 'utf8');

    const t1 = transport(dir);
    t1.sweep();
    t1.close();

    assert.deepEqual(readdirSync(logs).sort(), [...intrus].sort());
  });

  test('balaie dès la construction', (t) => {
    const dir = tempDir(t);
    const logs = join(dir, 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, `cubex-${today(-90)}.log`), 'x', 'utf8');

    transport(dir).close();

    assert.deepEqual(readdirSync(logs), []);
  });
});

describe('createLogger', () => {
  test('écrit une entrée JSON par ligne dans le fichier du jour', async (t) => {
    const dir = tempDir(t);
    const logger = createLogger(options(dir));

    logger.info('démarrage', { guild: '123' });
    logger.warn('section inconnue', { key: 'tickets' });
    await flush();
    logger.close();

    const contenu = readFileSync(join(dir, 'logs', `cubex-${today()}.log`), 'utf8');
    const lignes = contenu.trim().split('\n');

    assert.equal(lignes.length, 2);

    const première = JSON.parse(lignes[0]);
    assert.equal(première.level, 'info');
    assert.equal(première.message, 'démarrage');
    assert.equal(première.guild, '123');
    assert.equal(première.module, 'core');
    assert.match(première.timestamp, /^\d{4}-\d{2}-\d{2}T.+Z$/);
  });

  test('nomme le module qui écrit', async (t) => {
    const dir = tempDir(t);
    const logger = createLogger(options(dir));

    logger.forModule('config').error('configuration invalide', { count: 3 });
    await flush();
    logger.close();

    const entrée = JSON.parse(
      readFileSync(join(dir, 'logs', `cubex-${today()}.log`), 'utf8').trim(),
    );

    assert.equal(entrée.module, 'config');
    assert.equal(entrée.count, 3);
  });

  test('respecte le seuil de journalisation', async (t) => {
    const dir = tempDir(t);
    const logger = createLogger(options(dir, { level: 'warn' }));

    logger.error('retenu');
    logger.warn('retenu');
    logger.info('écarté');
    logger.debug('écarté');
    await flush();
    logger.close();

    const lignes = readFileSync(join(dir, 'logs', `cubex-${today()}.log`), 'utf8').trim().split('\n');

    assert.equal(lignes.length, 2);
    assert.ok(lignes.every((ligne) => JSON.parse(ligne).message === 'retenu'));
  });

  test('déplie la pile d\'une erreur au lieu de la réduire à un objet vide', async (t) => {
    const dir = tempDir(t);
    const logger = createLogger(options(dir));

    logger.error('appel réseau en échec', { error: new Error('connexion refusée') });
    await flush();
    logger.close();

    const entrée = JSON.parse(
      readFileSync(join(dir, 'logs', `cubex-${today()}.log`), 'utf8').trim(),
    );

    assert.match(JSON.stringify(entrée), /connexion refusée/);
  });

  test('expose la purge sans passer par le transport', async (t) => {
    const dir = tempDir(t);
    const logger = createLogger(options(dir));

    writeFileSync(join(dir, 'logs', `cubex-${today(-90)}.log`), 'x', 'utf8');
    const { deleted } = logger.sweep();
    logger.close();

    assert.equal(deleted, 1);
  });
});
