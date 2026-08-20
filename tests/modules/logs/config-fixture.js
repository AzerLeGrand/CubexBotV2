import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import { Configuration } from '../../../src/core/config/index.js';
import { buildConfigSchema } from '../../../src/core/config/schema/core.schema.js';
import { schema } from '../../../src/modules/logs/manifest.js';
import { configDir } from '../../../src/utils/paths.js';

/**
 * Configuration du dépôt, tous les événements de journalisation activés.
 *
 * **Les trois fichiers RÉELS sont copiés, pas réinventés** : un test qui
 * tournerait sur des gabarits fabriqués ne prouverait rien de ce qui est
 * livré — c'est le principe déjà tenu par `render.test.js`.
 *
 * Seules les bascules `logs.events.*.enabled` sont retournées. Elles sont
 * livrées à `false`, parce que le premier démarrage se fait sur le serveur
 * Cubex lui-même et que l'activation se fera famille par famille, à la main.
 * C'est un état d'EXPLOITATION, qui changera au fil des semaines : un test qui
 * en dépendrait tomberait le jour où le staff active une famille, et
 * l'enseignement serait nul.
 */

const FILES = Object.freeze(['config.yml', 'messages.yml', 'embeds.yml']);

/**
 * Retourne les bascules de la seule section `logs.events`.
 *
 * Le remplacement est borné à cette section : `minecraft.enabled` et
 * `footer.timestamp` vivent dans les mêmes fichiers et n'ont rien à voir ici.
 */
function enableEvents(source) {
  const start = source.indexOf('  events:');
  const end = source.indexOf('  grouping:');

  if (start === -1 || end === -1 || end < start) {
    throw new Error('section logs.events introuvable dans config.yml — le repère a bougé');
  }

  const block = source.slice(start, end).replaceAll('      enabled: false', '      enabled: true');

  return source.slice(0, start) + block + source.slice(end);
}

/** @returns {Configuration} chargée, prête à l'emploi */
export function logsConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'cubex-logs-config-'));

  for (const file of FILES) {
    const source = readFileSync(join(configDir, file), 'utf8');

    writeFileSync(join(dir, file), file === 'config.yml' ? enableEvents(source) : source, 'utf8');
  }

  after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  const config = new Configuration({ dir, configSchema: buildConfigSchema({ logs: schema }) });

  config.load();

  return config;
}
