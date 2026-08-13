import { statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { GatewayIntentBits } from 'discord.js';

import { AppError } from '../errors/app-error.js';
import { CORE_SECTION_NAMES } from '../config/schema/core.schema.js';
import { listModuleNames, MODULES_DIR } from './index.js';

/**
 * Manifestes de modules — étape 0 du démarrage.
 *
 * Un module pose à côté de son `index.js` un `manifest.js` FACULTATIF, où il
 * déclare les deux choses que le noyau doit connaître avant de pouvoir
 * démarrer : le fragment de `config.yml` qui lui appartient, et les intents
 * dont il a besoin. Les deux exports sont facultatifs indépendamment l'un de
 * l'autre.
 *
 *     export const schema = z.strictObject({ ... });
 *     export const intents = ['GuildMembers', 'GuildMessages'];
 *
 * UN MANIFESTE NE FAIT RIEN D'AUTRE QUE DÉCLARER. Aucun effet de bord, aucun
 * import du noyau, aucune lecture de fichier, aucun appel réseau. C'est la
 * seule chose du projet qui s'exécute dans le vide : il est lu avant les
 * secrets et avant la configuration, donc avant le logger, la base de données
 * et tout le reste. Rien de ce dont il pourrait avoir envie n'existe encore.
 *
 * D'où le fichier séparé, plutôt qu'un export de plus dans `index.js` : ce
 * dernier importe librement le noyau et déclare `init(ctx)`. L'importer avant
 * la configuration créerait un ordre de dépendance intenable dès qu'un module
 * ferait un import un peu ambitieux. Deux fichiers, deux moments, deux
 * contrats.
 */

/** Nom du fichier facultatif, à côté de l'`index.js` du module. */
const MANIFEST = 'manifest.js';

/**
 * Manifeste inutilisable. Distincte de `ModuleLoadError` : ces refus tombent à
 * l'étape 0, avant que quoi que ce soit ne soit ouvert, et s'écrivent sur
 * stderr faute de logger.
 */
export class ManifestError extends AppError {
  constructor(message, context = {}, cause) {
    super(message, { code: 'manifest_invalid', context, cause, expected: false });
  }
}

/**
 * Intents privilégiés, à cocher dans le portail développeur (socle §12).
 *
 * Constante de plateforme, comme `CATEGORY_CHANNEL_TYPE` dans `discord-refs.js`
 * : ce n'est pas un réglage du bot mais une propriété de Discord. La rendre
 * configurable ne changerait rien à ce que Discord exige, et une liste
 * désaccordée de la réalité ne produirait qu'un diagnostic faux.
 */
export const PRIVILEGED_INTENTS = Object.freeze([
  'GuildMembers',
  'GuildPresences',
  'MessageContent',
]);

/**
 * Balaie `src/modules/` et rassemble ce que les manifestes déclarent.
 *
 * Le balayage est celui de `loadModules()` — même fonction, donc même liste et
 * mêmes refus : un dossier sans `index.js` arrête le démarrage ici aussi. Les
 * deux passages doivent voir exactement les mêmes modules, sans quoi une
 * section pourrait être validée sans que son module ne soit chargé, ou
 * l'inverse.
 *
 * @param {object} [options]
 * @param {string} [options.directory] dossier des modules
 * @returns {Promise<{ modules: string[], fragments: Record<string, object>, intents: string[] }>}
 */
export async function loadManifests({ directory = MODULES_DIR } = {}) {
  const names = listModuleNames(directory);
  const fragments = {};
  const intents = [];

  for (const name of names) {
    const path = join(directory, name, MANIFEST);

    // Un module sans manifeste ne déclare rien. C'est le cas courant : un
    // module qui n'ajoute ni section ni intent n'a pas de fichier à écrire.
    if (!hasManifest(path, name)) continue;

    let manifest;

    try {
      // pathToFileURL est indispensable sous Windows : `import('D:\...')`
      // échoue, seule la forme file:// est acceptée.
      manifest = await import(pathToFileURL(path).href);
    } catch (cause) {
      // Jamais ignoré. L'ignorer signifierait qu'une section de config.yml
      // cesse d'être validée, en silence — et une section non validée est
      // exactement ce qui a arrêté la version précédente du bot. Même
      // raisonnement que pour un index.js non importable, voir loadModules().
      throw new ManifestError(
        `manifeste du module « ${name} » non importable : ${cause.message}`,
        { module: name, manifest: path },
        cause,
      );
    }

    if (manifest.schema !== undefined) fragments[name] = fragment(manifest.schema, name);
    if (manifest.intents !== undefined) intents.push(...declaredIntents(manifest.intents, name));
  }

  return { modules: names, fragments, intents };
}

/**
 * Union dédupliquée des intents, résolue en bits de la passerelle.
 *
 * L'ordre est celui de déclaration : le noyau d'abord, puis les modules dans
 * l'ordre binaire de leurs noms. Le journal du démarrage dit ainsi la même
 * chose d'une machine à l'autre.
 *
 * Refuse un nom inconnu, y compris dans la liste du noyau : `GatewayIntentBits`
 * rend `undefined` pour une clé qu'il ne connaît pas, et cet `undefined`
 * filerait jusqu'au client, où l'erreur devient illisible.
 *
 * @param {string[]} names noms d'intents, doublons admis
 * @returns {{ names: string[], bits: number[], privileged: string[] }}
 */
export function resolveIntents(names) {
  const unique = [...new Set(names)];

  for (const name of unique) {
    if (!isIntentName(name)) {
      throw new ManifestError(`intent Discord inconnu : ${quote(name)}`, { intent: name });
    }
  }

  return {
    names: unique,
    bits: unique.map((name) => GatewayIntentBits[name]),
    privileged: unique.filter((name) => PRIVILEGED_INTENTS.includes(name)),
  };
}

/** Le fragment de `config.yml` que le module revendique. */
function fragment(schema, name) {
  // Duck-typing plutôt qu'instanceof : dépendre des classes internes de zod
  // ferait échouer ce contrôle à la première montée de version majeure.
  if (typeof schema?.safeParse !== 'function') {
    throw fault(name, '« schema » doit être un schéma zod');
  }

  // La section porte le nom du dossier : aucun nom à déclarer dans le
  // manifeste, donc aucune collision possible entre deux modules. Reste celle
  // avec le noyau, qu'un module ne redéfinit pas.
  if (CORE_SECTION_NAMES.includes(name)) {
    throw fault(
      name,
      `sa section porte le nom d'une section du noyau (${CORE_SECTION_NAMES.join(', ')}) — ` +
        'un module ne redéfinit pas le noyau',
    );
  }

  return schema;
}

/** Les intents que le module réclame, vérifiés un à un. */
function declaredIntents(value, name) {
  if (!Array.isArray(value)) {
    throw fault(name, "« intents » doit être un tableau de noms d'intents");
  }

  for (const intent of value) {
    // Un nom, jamais une valeur numérique : le bit brut priverait le message
    // d'erreur du seul élément qui permette de retrouver la ligne fautive.
    if (!isIntentName(intent)) {
      throw fault(
        name,
        `intent Discord inconnu : ${quote(intent)} — attendu un nom exact de ` +
          'GatewayIntentBits, tel que GuildMembers (socle §12)',
      );
    }
  }

  return value;
}

/**
 * `GatewayIntentBits` est une énumération TypeScript compilée : elle porte
 * aussi la correspondance inverse, où `GatewayIntentBits[1]` vaut `'Guilds'`.
 * Tester la seule présence de la clé accepterait donc `"1"` comme nom d'intent.
 */
const isIntentName = (value) => typeof value === 'string' && typeof GatewayIntentBits[value] === 'number';

const fault = (name, message) =>
  new ManifestError(`manifeste du module « ${name} » : ${message}`, { module: name });

/** Cite la valeur fautive telle qu'elle a été écrite, guillemets compris. */
const quote = (value) => JSON.stringify(value) ?? String(value);

/**
 * Le module a-t-il un manifeste ?
 *
 * `throwIfNoEntry: false` distingue les deux cas qu'un `catch` confondrait :
 * fichier absent — le module ne déclare rien — et fichier présent mais
 * inaccessible, qui est un refus. Traiter le second comme le premier retirerait
 * sa section de la validation sans que rien ne le dise.
 */
function hasManifest(path, name) {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch (cause) {
    throw new ManifestError(
      `manifeste du module « ${name} » illisible : ${cause.message}`,
      { module: name, manifest: path },
      cause,
    );
  }
}
