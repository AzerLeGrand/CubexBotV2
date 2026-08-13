import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * Test de fumée de l'assemblage.
 *
 * `src/index.js` ne se teste pas unitairement — il connecte un bot. Mais il
 * importe une vingtaine de modules, et une erreur de chemin ou d'export ne se
 * verrait qu'au démarrage, sur le VPS. Cet import la fait apparaître ici.
 */
describe('src/index.js', () => {
  test('s\'importe sans démarrer le bot', async () => {
    const module = await import('../src/index.js');

    assert.equal(typeof module.bootstrap, 'function');
  });

  test('expose les registres du noyau sous leurs noms attendus', async () => {
    // Les modules recevront ce contexte : un renommage silencieux casserait
    // toutes les phases suivantes d'un coup.
    const [commands, purge, erasure, capabilities, embeds, loader, minecraft] = await Promise.all([
      import('../src/core/commands/index.js'),
      import('../src/core/purge/index.js'),
      import('../src/core/erasure/index.js'),
      import('../src/core/config/capabilities.js'),
      import('../src/core/embeds/index.js'),
      import('../src/core/loader/index.js'),
      import('../src/minecraft/index.js'),
    ]);

    assert.equal(typeof commands.createCommandRegistry, 'function');
    assert.equal(typeof purge.createPurgeRegistry, 'function');
    assert.equal(typeof erasure.createErasureRegistry, 'function');
    assert.equal(typeof capabilities.CapabilityRegistry, 'function');
    assert.equal(typeof embeds.createEmbedEngine, 'function');
    assert.equal(typeof loader.loadModules, 'function');
    assert.equal(typeof minecraft.createMinecraftBridge, 'function');
  });
});
