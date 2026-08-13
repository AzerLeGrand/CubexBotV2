import { readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { AppError } from '../errors/app-error.js';
import { fromRoot } from '../../utils/paths.js';

/**
 * Chargeur de modules (socle §4).
 *
 * Le noyau découvre les modules automatiquement : aucune liste à maintenir à la
 * main, donc aucune occasion d'oublier d'y inscrire un module.
 */

export const MODULES_DIR = fromRoot('src', 'modules');

/** Nom du fichier d'entrée attendu dans chaque dossier de module. */
const ENTRY = 'index.js';

export class ModuleLoadError extends AppError {
  constructor(message, context = {}, cause) {
    super(message, { code: 'module_load_failed', context, cause, expected: false });
  }
}

/**
 * Charge tous les modules présents.
 *
 * **Un module présent qui échoue à s'importer arrête le démarrage.** Jamais
 * ignoré : le traitement des migrations distingue un module retiré d'un module
 * actif sur la seule absence de sources, et un module présent mais non
 * importable produirait la même absence. Ses migrations cesseraient de
 * s'appliquer, ses tables resteraient là, et rien ne le dirait.
 *
 * @param {object} [options]
 * @param {string} [options.directory] dossier des modules
 * @param {object} options.logger
 * @returns {Promise<object[]>} modules normalisés, dans l'ordre de leur nom
 */
export async function loadModules({ directory = MODULES_DIR, logger } = {}) {
  const names = listModuleNames(directory);
  const modules = [];

  for (const name of names) {
    const moduleDir = join(directory, name);
    const entry = join(moduleDir, ENTRY);

    let loaded;

    try {
      // pathToFileURL est indispensable sous Windows : `import('D:\...')`
      // échoue, seule la forme file:// est acceptée.
      loaded = await import(pathToFileURL(entry).href);
    } catch (cause) {
      throw new ModuleLoadError(
        `module « ${name} » non importable : ${cause.message}`,
        { module: name, entry },
        cause,
      );
    }

    modules.push(normalize(loaded, name, moduleDir));
  }

  logger.info('modules chargés', { count: modules.length, modules: names });

  return modules;
}

/**
 * Sources de migration des modules, prêtes pour `database.migrate()`.
 *
 * Un module sans migration n'en produit pas — mais il reste dans la liste des
 * modules chargés, ce qui suffit à ne pas le confondre avec un module retiré.
 */
export function migrationSources(modules) {
  return modules
    .filter((module) => module.migrations !== null)
    .map((module) => ({ owner: module.name, directory: module.migrations }));
}

/** Dossiers de `src/modules/`, triés par comparaison binaire. */
function listModuleNames(directory) {
  let entries;

  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (cause) {
    // Aucun module écrit : c'est l'état normal de la phase 0.
    if (cause.code === 'ENOENT') return [];

    throw new ModuleLoadError(`dossier des modules illisible : ${directory}`, { directory }, cause);
  }

  const names = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const path = join(directory, entry.name, ENTRY);

    try {
      statSync(path);
    } catch {
      // Un dossier sans point d'entrée est refusé, jamais passé sous silence :
      // c'est indistinguable d'un module qu'on croit chargé et qui ne l'est pas.
      throw new ModuleLoadError(
        `le dossier « ${entry.name} » de src/modules/ ne contient pas de ${ENTRY}`,
        { module: entry.name },
      );
    }

    names.push(entry.name);
  }

  // Même règle que les migrations : comparaison binaire, jamais localeCompare,
  // dont le résultat dépend de l'ICU chargée.
  return names.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

/**
 * Valide la forme d'un module et complète ce qui est facultatif.
 *
 * `init` est optionnelle : un module purement déclaratif — des migrations et
 * des déclarations de rétention, sans état à monter — n'a pas à écrire une
 * fonction vide pour la forme.
 */
function normalize(loaded, name, moduleDir) {
  const fault = (message) => {
    throw new ModuleLoadError(`module « ${name} » : ${message}`, { module: name });
  };

  if (loaded.name !== name) {
    // Le nom porte l'identité des migrations et des commandes. Un écart entre
    // le dossier et la déclaration ferait diverger les deux silencieusement.
    fault(`son export « name » vaut ${JSON.stringify(loaded.name)}, attendu ${JSON.stringify(name)}`);
  }

  for (const field of ['commands', 'events', 'retention']) {
    if (loaded[field] !== undefined && !Array.isArray(loaded[field])) fault(`« ${field} » doit être un tableau`);
  }

  if (loaded.init !== undefined && typeof loaded.init !== 'function') {
    fault('« init » doit être une fonction');
  }

  return {
    name,
    directory: moduleDir,
    commands: loaded.commands ?? [],
    events: loaded.events ?? [],
    retention: loaded.retention ?? [],
    migrations: resolveMigrations(loaded.migrations, moduleDir, fault),
    init: loaded.init ?? null,
  };
}

/** `migrations` est un chemin, relatif au dossier du module ou absolu. */
function resolveMigrations(value, moduleDir, fault) {
  if (value === undefined || value === null) return null;

  const path = value instanceof URL ? value.pathname : value;

  if (typeof path !== 'string') {
    fault('« migrations » doit être un chemin de dossier');
  }

  return isAbsolute(path) ? path : resolve(moduleDir, path);
}
