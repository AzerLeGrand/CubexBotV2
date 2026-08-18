import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { CapabilityRegistry } from '../../../src/core/config/capabilities.js';
import { Configuration } from '../../../src/core/config/index.js';
import { buildConfigSchema } from '../../../src/core/config/schema/core.schema.js';
import { createDatabase } from '../../../src/core/database/index.js';
import { CORE_OWNER } from '../../../src/core/database/migrations.js';
import { AUDIT_ACTION_NAMES, logChannelCapability } from '../../../src/modules/logs/constants.js';
import {
  attach,
  capabilities as declared,
  getPending,
  getRecorder,
  init,
  name,
} from '../../../src/modules/logs/index.js';
import { schema } from '../../../src/modules/logs/manifest.js';
import { fromRoot } from '../../../src/utils/paths.js';

/**
 * Câblage du module et mode dégradé.
 *
 * `init()` tourne AVANT la connexion : ni le journal d'audit, ni les rôles, ni
 * l'identifiant du bot n'existent encore. Le module doit se monter quand même,
 * fonctionner en dégradé — tout en `unknown` — et le dire une fois.
 *
 * Aucun import de discord.js : `attach()` reçoit ce dont il a besoin.
 */

const MEMBRE = '123456789012345678';
const AT = new Date(Date.UTC(2026, 7, 18, 14, 32, 7, 512));

const fakeLogger = () => {
  const entries = [];
  const record = (level) => (message, context) => entries.push({ level, message, context });
  const logger = {
    entries,
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    of: (level) => entries.filter((entry) => entry.level === level),
  };

  logger.forModule = () => logger;

  return logger;
};

/** Configuration réelle du dépôt : c'est elle qui porte les défauts du schéma. */
const config = new Configuration({ configSchema: buildConfigSchema({ logs: schema }) });

config.load();

const mount = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cubex-logs-wiring-'));
  const logger = fakeLogger();
  const database = createDatabase({ file: join(root, 'test.sqlite'), logger: fakeLogger() });

  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    // L'état du module est global : on le remet en dégradé pour le test suivant.
    attach({ fetchEntries: null, resolveRoles: null, botUserId: null });
  });

  database.migrate([
    { owner: CORE_OWNER, directory: fromRoot('migrations') },
    { owner: name, directory: fromRoot('src', 'modules', 'logs', 'migrations') },
  ]);

  const capabilities = new CapabilityRegistry();

  for (const declaration of declared) capabilities.declare(declaration.id, { module: name });

  const arrets = [];

  init({
    config,
    database,
    logger,
    capabilities,
    shutdown: { register: (step, close) => arrets.push({ step, close }) },
  });

  return {
    arrets,
    database,
    logger,
    rows: (table) => database.prepare(`SELECT * FROM ${table}`).all(),
  };
};

const input = (patch = {}) => ({
  type: 'member_ban',
  occurredAt: AT,
  actorId: null,
  actorConfidence: 'unknown',
  targetId: MEMBRE,
  channelId: null,
  source: 'live',
  ...patch,
});

describe('montage', () => {
  test('monte le dépôt, la file et le point d\'entrée unique', (t) => {
    mount(t);

    assert.notEqual(getRecorder(), null);
    assert.notEqual(getPending(), null);
    assert.equal(typeof getRecorder().record, 'function');
  });

  test('inscrit le vidage de la file auprès de la séquence d\'arrêt', (t) => {
    // Un événement encore en attente quand le bot s'arrête n'existe nulle part
    // ailleurs : Discord ne le rejouera pas.
    const { arrets } = mount(t);

    assert.deepEqual(arrets.map((held) => held.step), [name]);
    assert.equal(typeof arrets[0].close, 'function');
  });

  test('annonce l\'état dégradé une seule fois, en info', (t) => {
    const { logger } = mount(t);

    const montage = logger.of('info').filter((held) => held.message.includes('montée'));

    assert.equal(montage.length, 1);
    assert.equal(montage[0].context.discord_attached, false);
    assert.equal(montage[0].context.write_delay_ms > 0, true, 'le défaut du schéma est lu');
  });
});

describe('mode dégradé, avant attach()', () => {
  test('écrit quand même, en unknown', async (t) => {
    // Aucune corrélation possible sans accès au journal d'audit. Écrire
    // `unknown` est le résultat correct, pas un échec.
    const { rows } = mount(t);

    const resultat = await getRecorder().record(input());

    assert.notEqual(resultat, null);

    const [ligne] = rows('log_events');

    assert.equal(ligne.actor_id, null);
    assert.equal(ligne.actor_confidence, 'unknown');
  });

  test('n\'exclut personne faute d\'identité du bot', async (t) => {
    // Mieux vaut journaliser de trop que d'ignorer à tort : un événement ignoré
    // ne laisse aucune trace.
    const { rows } = mount(t);

    await getRecorder().record(input({ targetId: MEMBRE }));

    assert.equal(rows('log_events').length, 1);
  });

  test('aucun avertissement : le dégradé n\'est pas une panne', async (t) => {
    const { logger } = mount(t);

    await getRecorder().record(input());

    assert.equal(logger.of('warn').length, 0);
    assert.equal(logger.of('error').length, 0);
  });
});

describe('attach()', () => {
  test('branche les trois accès', (t) => {
    mount(t);

    const branche = attach({
      fetchEntries: async () => [],
      resolveRoles: async () => [],
      botUserId: '444444444444444444',
    });

    assert.equal(typeof branche.fetchEntries, 'function');
    assert.equal(typeof branche.resolveRoles, 'function');
    assert.equal(branche.botUserId, '444444444444444444');
  });

  test('la corrélation devient effective sans remontage', async (t) => {
    // Les adaptateurs consultent l'état à CHAQUE appel : figer la valeur au
    // montage laisserait le module dégradé pour toujours.
    const { rows } = mount(t);

    // Horodatage courant, et non la constante du fichier : le VRAI cache écarte
    // les entrées plus vieilles que la fenêtre de corrélation, mesurée depuis
    // maintenant. C'est ce qui distingue ce test de ceux de correlation.test.js,
    // où le cache est factice et ne purge rien.
    const maintenant = new Date();

    attach({
      fetchEntries: async () => [
        {
          id: '900000000000000001',
          actionName: 'MemberBanAdd',
          executorId: '111111111111111111',
          targetId: MEMBRE,
          channelId: null,
          count: 1,
          createdAt: maintenant,
        },
      ],
      resolveRoles: async () => [],
      botUserId: '444444444444444444',
    });

    await getRecorder().record(input({ occurredAt: maintenant }));

    const [ligne] = rows('log_events');

    assert.equal(ligne.actor_id, '111111111111111111');
    assert.equal(ligne.actor_confidence, 'probable');
  });

  test('vérifie les noms d\'action quand l\'énumération est fournie', (t) => {
    mount(t);

    const complete = Object.fromEntries(AUDIT_ACTION_NAMES.map((held, i) => [held, i + 1]));

    assert.doesNotThrow(() =>
      attach({ fetchEntries: async () => [], resolveRoles: async () => [], botUserId: '1', auditActions: complete }),
    );

    const { MemberKick: _absent, ...incomplete } = complete;

    assert.throws(
      () =>
        attach({
          fetchEntries: async () => [],
          resolveRoles: async () => [],
          botUserId: '1',
          auditActions: incomplete,
        }),
      /MemberKick/,
    );
  });
});

describe('capacités déclarées', () => {
  test('l\'aiguillage interroge exactement les capacités déclarées', (t) => {
    mount(t);

    assert.deepEqual(
      declared.map((held) => held.id),
      ['messages', 'voice', 'members', 'server', 'moderation'].map(logChannelCapability),
    );
  });
});
