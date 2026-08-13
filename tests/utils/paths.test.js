import assert from 'node:assert/strict';
import { isAbsolute } from 'node:path';
import { describe, test } from 'node:test';

import { isAbsolutePath } from '../../src/utils/paths.js';

/**
 * Ces cas doivent donner le même verdict sur Windows et sur Linux : ils
 * décrivent des valeurs venues de fichiers versionnés, lues par les deux
 * plateformes.
 */
describe('isAbsolutePath', () => {
  const absolus = [
    'C:\\cubex\\base.sqlite',
    'C:/cubex/base.sqlite',
    'c:/cubex/base.sqlite',
    'C:base.sqlite',
    '/var/lib/cubex/base.sqlite',
    '/logs',
    '\\\\serveur\\partage\\base.sqlite',
  ];

  const relatifs = ['data/cubex.sqlite', 'logs', 'data/sous/dossier', './data', '../data'];

  test('reconnaît les chemins absolus des deux conventions', () => {
    for (const value of absolus) assert.equal(isAbsolutePath(value), true, value);
  });

  test('laisse passer les chemins relatifs', () => {
    for (const value of relatifs) assert.equal(isAbsolutePath(value), false, value);
  });

  test('le verdict ne dépend pas de la plateforme d\'exécution', () => {
    // Ce test échouerait avec path.isAbsolute() : sous Linux il rendrait false
    // sur C:\… et laisserait passer un chemin commité depuis Windows. C'est
    // exactement la panne relevée sur le VPS.
    const natif = absolus.filter((value) => !isAbsolute(value));

    assert.ok(
      natif.length > 0 || process.platform === 'win32',
      'sous Linux, au moins un chemin Windows doit échapper à path.isAbsolute()',
    );

    for (const value of natif) assert.equal(isAbsolutePath(value), true, value);
  });

  test('ne se laisse pas surprendre par une valeur non textuelle', () => {
    for (const value of [undefined, null, 42, {}]) assert.equal(isAbsolutePath(value), false);
  });
});
