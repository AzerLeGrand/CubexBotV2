import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

import { projectRoot } from '../../../src/utils/paths.js';

/**
 * `src/core/logging/` expose sa propre interface. Aucun autre fichier du projet
 * ne connaît winston.
 *
 * C'est cette règle qui a permis d'écarter sans risque un transport de rotation
 * abandonné, et qui permettra de changer de bibliothèque le jour venu sans
 * toucher au reste du code.
 */

const SOURCE = join(projectRoot, 'src');
const ISOLATED = join('core', 'logging');

const BANNED = /winston|triple-beam/;

function* jsFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) yield* jsFiles(path);
    else if (entry.name.endsWith('.js')) yield path;
  }
}

test('aucun fichier hors de src/core/logging ne mentionne winston', () => {
  const coupables = [];

  for (const file of jsFiles(SOURCE)) {
    const relatif = relative(SOURCE, file);

    if (relatif.startsWith(`${ISOLATED}${sep}`)) continue;
    if (BANNED.test(readFileSync(file, 'utf8'))) coupables.push(relatif);
  }

  assert.deepEqual(
    coupables,
    [],
    `la journalisation doit rester isolée derrière son interface : ${coupables.join(', ')}`,
  );
});

test('le dossier isolé existe bien et contient les seuls appels', () => {
  // Garde-fou contre un test qui passerait pour la mauvaise raison : un chemin
  // devenu faux ferait un scan vide et une assertion toujours vraie.
  const isolés = [...jsFiles(join(SOURCE, ISOLATED))];

  assert.ok(isolés.length > 0, 'src/core/logging est introuvable ou vide');
  assert.ok(
    isolés.some((file) => BANNED.test(readFileSync(file, 'utf8'))),
    'aucun fichier de src/core/logging n\'importe winston : le motif de recherche est-il encore juste ?',
  );
});
