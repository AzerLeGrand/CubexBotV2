import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';

import { fromRoot } from '../../../src/utils/paths.js';

/**
 * `src/modules/logs/discord/` est la seule couture avec discord.js.
 *
 * Tout le reste du module — normalisation, corrélation, exclusions, groupement,
 * rendu, aiguillage — n'en connaît rien, et c'est ce qui permet de l'éprouver en
 * mémoire, sans réseau ni jeton. La règle a une valeur pratique immédiate : les
 * quatre lots précédents ont été vérifiés ainsi, et ils doivent le rester.
 *
 * Même discipline que `src/core/logging/`, qui isole winston derrière son
 * interface.
 */

const MODULE = fromRoot('src', 'modules', 'logs');
const ISOLATED = 'discord';

/**
 * Le contrôle porte sur l'IMPORT, pas sur la mention.
 *
 * Le nom de la bibliothèque apparaît dans les commentaires — `index.js` explique
 * précisément qu'il ne l'importe pas — et une recherche de texte brut le
 * signalerait comme une faute. Ce qui compte est la dépendance réelle : un
 * `import … from 'discord.js'` ou un `import('discord.js')`.
 */
const IMPORT = /(?:from|import\s*\()\s*['"]discord\.js['"]/;

function* jsFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) yield* jsFiles(path);
    else if (entry.name.endsWith('.js')) yield path;
  }
}

test('aucun fichier du module hors de discord/ n\'importe discord.js', () => {
  const coupables = [];

  for (const file of jsFiles(MODULE)) {
    const relatif = relative(MODULE, file);

    if (relatif.startsWith(`${ISOLATED}${sep}`)) continue;
    if (IMPORT.test(readFileSync(file, 'utf8'))) coupables.push(relatif);
  }

  assert.deepEqual(
    coupables,
    [],
    `discord.js doit rester confiné à src/modules/logs/discord/ : ${coupables.join(', ')}`,
  );
});

test('le dossier isolé existe bien et porte les seuls imports', () => {
  // Garde-fou contre un test qui passerait pour la mauvaise raison : un chemin
  // devenu faux ferait un balayage vide et une assertion toujours vraie.
  const isolés = [...jsFiles(join(MODULE, ISOLATED))];

  assert.ok(isolés.length > 0, 'src/modules/logs/discord est introuvable ou vide');
  assert.ok(
    isolés.some((file) => IMPORT.test(readFileSync(file, 'utf8'))),
    'aucun fichier de discord/ n\'importe discord.js : le motif est-il encore juste ?',
  );
});
