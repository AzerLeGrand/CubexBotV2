import { ConfigError } from './errors.js';
import { CONFIG_FILES } from './loader.js';

/**
 * Détection de secrets dans les fichiers YAML (socle §5.3).
 *
 * Les motifs ci-dessous ne sont pas configurables, et c'est délibéré : rendre
 * réglable un détecteur depuis le fichier même qu'il surveille reviendrait à
 * permettre de le désactiver depuis l'endroit qu'il protège.
 */

/**
 * Première passe — sur les NOMS de clés uniquement.
 *
 * Ces mots-clés ne sont jamais cherchés dans les valeurs : `tech_logs.redaction
 * .patterns` (phase 6) contient par construction des motifs qui reconnaissent
 * « token » et « password », et un détecteur naïf ferait échouer le démarrage
 * sur la configuration du masquage de secrets.
 */
const SECRET_KEY_WORDS = Object.freeze(['token', 'password', 'secret', 'api_key', 'apikey']);

/**
 * Seconde passe — sur les VALEURS, formes de secrets réels uniquement.
 *
 * Un mot-clé dans une valeur n'a rien de suspect ; une chaîne qui a la forme
 * d'un jeton en a la valeur.
 */
const SECRET_VALUE_PATTERNS = Object.freeze([
  {
    label: "jeton de bot Discord",
    pattern: /^[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}$/,
  },
  { label: "clé d'API OpenAI", pattern: /^sk-[A-Za-z0-9_-]{20,}$/ },
  { label: "jeton d'accès GitHub", pattern: /^gh[pousr]_[A-Za-z0-9]{36,}$/ },
  { label: "jeton d'accès Slack", pattern: /^xox[baprs]-[A-Za-z0-9-]{10,}$/ },
  { label: "clé d'accès AWS", pattern: /^AKIA[0-9A-Z]{16}$/ },
]);

const KEY_HINT =
  'les secrets vivent dans .env, jamais dans un YAML versionné — ' +
  'déplacer la valeur et la lire depuis les variables d\'environnement';

/**
 * Parcourt les trois fichiers à la recherche de secrets.
 *
 * Travaille sur l'arbre brut : un fichier que zod a refusé peut parfaitement
 * contenir un jeton, et c'est même le cas le plus probable.
 *
 * @param {Record<string, object|null>} files arbres bruts, indexés comme CONFIG_FILES
 * @returns {ConfigError[]}
 */
export function detectSecrets(files) {
  const errors = [];

  for (const [key, name] of Object.entries(CONFIG_FILES)) {
    walk(files[key], [], name, errors);
  }

  return errors;
}

function walk(node, path, file, errors) {
  if (node === null || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    node.forEach((item, index) => walk(item, [...path, String(index)], file, errors));
    return;
  }

  for (const [key, value] of Object.entries(node)) {
    const here = [...path, key];

    const word = matchedKeyWord(key);
    if (word) {
      errors.push(
        new ConfigError({
          file,
          path: here,
          message: `nom de clé évoquant un secret : « ${word} »`,
          hint: KEY_HINT,
        }),
      );
    }

    if (typeof value === 'string') {
      const match = SECRET_VALUE_PATTERNS.find(({ pattern }) => pattern.test(value));
      if (match) {
        // La valeur n'est pas citée : elle serait recopiée dans les journaux,
        // qui sont relayés vers Discord en phase 6.
        errors.push(
          new ConfigError({
            file,
            path: here,
            message: `valeur ayant la forme d'un secret (${match.label})`,
            hint: KEY_HINT,
          }),
        );
      }
    }

    walk(value, here, file, errors);
  }
}

/** Comparaison sur le nom normalisé, pour attraper `apiKey` comme `api_key`. */
function matchedKeyWord(key) {
  const normalized = key.toLowerCase().replace(/[^a-z]/g, '');

  return SECRET_KEY_WORDS.find((word) => normalized.includes(word.replace(/_/g, '')));
}
