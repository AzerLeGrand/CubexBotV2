import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Crée un dossier temporaire contenant les fichiers donnés, supprimé à la fin
 * du test. Évite d'entretenir une arborescence de fixtures versionnée dont
 * chaque cas exigerait trois fichiers.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string>} files nom de fichier → contenu
 * @returns {string} chemin du dossier
 */
export function tempDir(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cubex-'));

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }

  t.after(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
}

/**
 * Restaure les variables d'environnement citées à la fin du test.
 * process.loadEnvFile() modifie process.env : sans cela, un test contaminerait
 * les suivants du même fichier.
 *
 * @param {import('node:test').TestContext} t
 * @param {string[]} keys
 */
export function preserveEnv(t, keys) {
  const saved = new Map(keys.map((key) => [key, process.env[key]]));

  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}
