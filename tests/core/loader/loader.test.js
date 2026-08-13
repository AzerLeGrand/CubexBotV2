import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { loadModules, migrationSources, ModuleLoadError } from '../../../src/core/loader/index.js';

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

/**
 * Dossier de modules réel : le chargeur importe vraiment, un faux ne prouverait
 * rien de ce qui compte ici.
 */
const sandbox = (t) => {
  const root = mkdtempSync(join(tmpdir(), 'cubex-mod-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const write = (name, source, extra = {}) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    if (source !== null) writeFileSync(join(dir, 'index.js'), source, 'utf8');

    for (const [file, content] of Object.entries(extra)) {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), content, 'utf8');
    }

    return dir;
  };

  return { root, write };
};

const MODULE = (name, body = '') => `export const name = '${name}';\n${body}`;

describe('loadModules', () => {
  test('rend une liste vide quand aucun module n\'existe', async () => {
    const logger = fakeLogger();

    const modules = await loadModules({ directory: join(tmpdir(), 'cubex-absent-xyz'), logger });

    assert.deepEqual(modules, []);
  });

  test('découvre les modules sans liste à maintenir', async (t) => {
    const { root, write } = sandbox(t);
    const logger = fakeLogger();

    write('tickets', MODULE('tickets'));
    write('appeals', MODULE('appeals'));

    const modules = await loadModules({ directory: root, logger });

    assert.deepEqual(modules.map((module) => module.name), ['appeals', 'tickets']);
    assert.equal(logger.of('info')[0].context.count, 2);
  });

  test('complète ce qui est facultatif', async (t) => {
    const { root, write } = sandbox(t);
    write('vide', MODULE('vide'));

    const [module] = await loadModules({ directory: root, logger: fakeLogger() });

    assert.deepEqual(module.commands, []);
    assert.deepEqual(module.components, []);
    assert.deepEqual(module.events, []);
    assert.deepEqual(module.retention, []);
    assert.equal(module.migrations, null);
    assert.equal(module.init, null, 'un module déclaratif n\'écrit pas une init vide');
    assert.equal(module.ready, null, 'ni un ready vide');
  });

  test('conserve ce que le module déclare', async (t) => {
    const { root, write } = sandbox(t);
    write(
      'logs',
      MODULE(
        'logs',
        `export const retention = [{ table: 'log_events', date_column: 'created_at', retention_key: 'k' }];
         export const commands = [{ name: 'history' }];
         export function init() { return 'monté'; }
         export function ready() { return 'connecté'; }`,
      ),
    );

    const [module] = await loadModules({ directory: root, logger: fakeLogger() });

    assert.equal(module.retention[0].table, 'log_events');
    assert.equal(module.commands[0].name, 'history');
    assert.equal(module.init(), 'monté');
    assert.equal(module.ready(), 'connecté');
  });

  test('résout un chemin de migrations relatif au dossier du module', async (t) => {
    const { root, write } = sandbox(t);
    const dir = write('tickets', MODULE('tickets', `export const migrations = './migrations';`));

    const [module] = await loadModules({ directory: root, logger: fakeLogger() });

    assert.equal(module.migrations, join(dir, 'migrations'));
    assert.deepEqual(migrationSources([module]), [
      { owner: 'tickets', directory: join(dir, 'migrations') },
    ]);
  });

  test('n\'inscrit aucune source pour un module sans migration', async (t) => {
    const { root, write } = sandbox(t);
    write('vide', MODULE('vide'));

    const modules = await loadModules({ directory: root, logger: fakeLogger() });

    assert.deepEqual(migrationSources(modules), []);
  });
});

describe('un module cassé arrête le démarrage', () => {
  test('erreur de syntaxe', async (t) => {
    const { root, write } = sandbox(t);
    write('casse', 'export const name = ;;;');

    // Jamais ignoré : le traitement des migrations distingue un module retiré
    // d'un module actif sur la seule absence de sources.
    await assert.rejects(() => loadModules({ directory: root, logger: fakeLogger() }), ModuleLoadError);
  });

  test('import introuvable', async (t) => {
    const { root, write } = sandbox(t);
    write('casse', `import './inexistant.js';\nexport const name = 'casse';`);

    await assert.rejects(
      () => loadModules({ directory: root, logger: fakeLogger() }),
      /non importable/,
    );
  });

  test('exception levée au chargement', async (t) => {
    const { root, write } = sandbox(t);
    write('casse', `throw new Error('boum');\nexport const name = 'casse';`);

    await assert.rejects(() => loadModules({ directory: root, logger: fakeLogger() }), /boum/);
  });

  test('dossier sans index.js', async (t) => {
    const { root, write } = sandbox(t);
    write('orphelin', null);

    await assert.rejects(
      () => loadModules({ directory: root, logger: fakeLogger() }),
      /ne contient pas de index\.js/,
    );
  });
});

describe('validation de la forme', () => {
  const rejette = async (t, source, motif) => {
    const { root, write } = sandbox(t);
    write('module', source);

    await assert.rejects(() => loadModules({ directory: root, logger: fakeLogger() }), motif);
  };

  test('nom divergent du dossier', async (t) => {
    // Le nom porte l'identité des migrations : un écart les ferait diverger.
    await rejette(t, `export const name = 'autre';`, /attendu "module"/);
  });

  test('nom absent', async (t) => {
    await rejette(t, 'export const commands = [];', /export « name »/);
  });

  test('commands, components, events ou retention qui ne sont pas des tableaux', async (t) => {
    for (const field of ['commands', 'components', 'events', 'retention']) {
      await rejette(t, MODULE('module', `export const ${field} = {};`), /doit être un tableau/);
    }
  });

  test('init ou ready qui n\'est pas une fonction', async (t) => {
    for (const hook of ['init', 'ready']) {
      await rejette(
        t,
        MODULE('module', `export const ${hook} = 42;`),
        new RegExp(`« ${hook} » doit être une fonction`),
      );
    }
  });
});
