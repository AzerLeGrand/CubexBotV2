import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import yaml from 'js-yaml';

import { ConfigError } from './errors.js';
import { configDir } from '../../utils/paths.js';

/**
 * Les trois fichiers, séparés par nature (socle §5.1). La clé est le nom sous
 * lequel l'arbre est exposé au reste du module.
 */
export const CONFIG_FILES = Object.freeze({
  config: 'config.yml',
  messages: 'messages.yml',
  embeds: 'embeds.yml',
});

/**
 * Lit et analyse les trois fichiers de configuration.
 *
 * Les trois sont toujours tentés, même si le premier échoue : présenter une
 * anomalie à la fois obligerait à redémarrer le bot autant de fois qu'il y a
 * d'erreurs (socle §5.4). Aucune validation de contenu ici, seulement la forme
 * du document.
 *
 * @param {object} [options]
 * @param {string} [options.dir] dossier contenant les trois fichiers
 * @returns {{ files: Record<string, object|null>, errors: ConfigError[] }}
 */
export function loadYamlFiles({ dir = configDir } = {}) {
  const files = {};
  const errors = [];

  for (const [key, name] of Object.entries(CONFIG_FILES)) {
    const { data, error } = readYamlFile(join(dir, name), name);
    files[key] = data;
    if (error) errors.push(error);
  }

  return { files, errors };
}

function readYamlFile(path, name) {
  let content;

  try {
    content = readFileSync(path, 'utf8');
  } catch (cause) {
    const message =
      cause.code === 'ENOENT'
        ? 'fichier introuvable'
        : `fichier illisible : ${cause.message}`;
    const hint =
      cause.code === 'ENOENT'
        ? `les trois fichiers de configuration sont versionnés — attendu à ${path}`
        : `vérifier les droits de lecture sur ${path}`;

    return { data: null, error: new ConfigError({ file: name, message, hint }) };
  }

  let data;

  try {
    // js-yaml refuse les clés dupliquées : une section recopiée puis modifiée
    // à moitié écraserait silencieusement la première.
    data = yaml.load(content, { filename: name });
  } catch (cause) {
    // `mark.line` est indexé à partir de zéro, les éditeurs comptent à partir de un.
    const line = cause.mark ? cause.mark.line + 1 : null;

    return {
      data: null,
      error: new ConfigError({
        file: name,
        line,
        message: `YAML invalide : ${cause.reason ?? cause.message}`,
      }),
    };
  }

  if (data === null || data === undefined) {
    return {
      data: null,
      error: new ConfigError({
        file: name,
        message: 'fichier vide',
        hint: 'un fichier sans contenu est presque toujours un fichier écrasé par erreur',
      }),
    };
  }

  if (typeof data !== 'object' || Array.isArray(data)) {
    return {
      data: null,
      error: new ConfigError({
        file: name,
        message: `la racine du document doit être un ensemble de clés, reçu ${describe(data)}`,
      }),
    };
  }

  return { data, error: null };
}

const describe = (value) => (Array.isArray(value) ? 'une liste' : `un ${typeof value}`);
