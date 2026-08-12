import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadEnv } from '../../../src/core/config/env.js';
import { preserveEnv, tempDir } from '../../helpers/fixtures.js';

const KEYS = ['DISCORD_TOKEN', 'DISCORD_CLIENT_ID', 'NODE_ENV'];

const COMPLETE = {
  DISCORD_TOKEN: 'jeton-factice',
  DISCORD_CLIENT_ID: '123456789012345678',
  NODE_ENV: 'development',
};

const ABSENT = join('dossier', 'sans', '.env');

test('lit le fichier .env et retourne les trois secrets', (t) => {
  preserveEnv(t, KEYS);
  const dir = tempDir(t, {
    '.env': 'DISCORD_TOKEN=jeton-factice\nDISCORD_CLIENT_ID=123456789012345678\nNODE_ENV=production\n',
  });

  const { env, errors } = loadEnv({ file: join(dir, '.env') });

  assert.deepEqual(errors, []);
  assert.equal(env.DISCORD_TOKEN, 'jeton-factice');
  assert.equal(env.DISCORD_CLIENT_ID, '123456789012345678');
  assert.equal(env.NODE_ENV, 'production');
});

test('accepte un .env absent quand les variables viennent de l\'environnement', () => {
  const { env, errors } = loadEnv({ file: ABSENT, source: COMPLETE });

  assert.deepEqual(errors, []);
  assert.equal(env.NODE_ENV, 'development');
});

test('refuse une clé absente en la nommant', () => {
  const { DISCORD_TOKEN, ...incomplete } = COMPLETE;

  const { env, errors } = loadEnv({ file: ABSENT, source: incomplete });

  assert.equal(env, null);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, '.env');
  assert.equal(errors[0].key, 'DISCORD_TOKEN');
  assert.match(errors[0].hint, /\.env\.example/);
});

test('refuse une valeur vide', () => {
  const { errors } = loadEnv({
    file: ABSENT,
    source: { ...COMPLETE, DISCORD_TOKEN: '' },
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].key, 'DISCORD_TOKEN');
  assert.match(errors[0].message, /vide/);
});

test('refuse un NODE_ENV hors des deux valeurs attendues', () => {
  const { errors } = loadEnv({
    file: ABSENT,
    source: { ...COMPLETE, NODE_ENV: 'staging' },
  });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].key, 'NODE_ENV');
  assert.match(errors[0].message, /production/);
  assert.match(errors[0].message, /development/);
});

test('collecte toutes les clés manquantes d\'un coup', () => {
  const { env, errors } = loadEnv({ file: ABSENT, source: {} });

  assert.equal(env, null);
  assert.equal(errors.length, 3);
  assert.deepEqual(errors.map((error) => error.key).sort(), [...KEYS].sort());
});

test('n\'expose aucune variable hors des trois déclarées', () => {
  const { env } = loadEnv({
    file: ABSENT,
    source: { ...COMPLETE, PATH: '/usr/bin', DATABASE_URL: 'postgres://…' },
  });

  assert.deepEqual(Object.keys(env).sort(), [...KEYS].sort());
});
