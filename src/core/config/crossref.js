import { ConfigError } from './errors.js';
import { CONFIG_FILES } from './loader.js';

/**
 * Validation croisée entre les trois fichiers.
 *
 * Travaille sur les arbres BRUTS, jamais sur la sortie de zod : c'est la seule
 * façon de rester exécutable quand le schéma a déjà échoué, et le socle §5.4
 * exige que toutes les anomalies soient présentées ensemble.
 *
 * Sens unique : un renvoi qui ne résout pas est une erreur, une clé de
 * messages.yml que rien n'utilise n'en est pas une — elle sert peut-être un
 * module qui n'est pas encore écrit.
 */

const KEY_SUFFIX = '_key';

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * @param {Record<string, object|null>} files arbres bruts, indexés comme CONFIG_FILES
 * @returns {ConfigError[]}
 */
export function crossReference(files) {
  const errors = [];

  checkMessageKeys(files.config, CONFIG_FILES.config, files.messages, errors);
  checkMessageKeys(files.embeds, CONFIG_FILES.embeds, files.messages, errors);
  checkTemplateColors(files.embeds, errors);

  return errors;
}

/**
 * Chaque champ `*_key` pointe vers un texte existant de messages.yml.
 *
 * Si messages.yml n'a pas pu être lu, la vérification est abandonnée : le
 * chargeur a déjà signalé le fichier, et déclarer introuvables les quarante
 * clés d'un fichier absent noierait l'anomalie réelle.
 */
function checkMessageKeys(tree, file, messages, errors) {
  if (!isRecord(tree) || !isRecord(messages)) return;

  for (const { path, value } of walk(tree)) {
    const key = path.at(-1);
    if (!key.endsWith(KEY_SUFFIX)) continue;

    if (typeof value !== 'string') continue; // le schéma le signale déjà

    const target = resolve(messages, value);

    if (target === undefined) {
      errors.push(
        new ConfigError({
          file,
          path,
          message: `renvoi vers un texte inexistant : ${value}`,
          hint: `ajouter la clé ${value} dans ${CONFIG_FILES.messages}`,
        }),
      );
    } else if (!isText(target)) {
      errors.push(
        new ConfigError({
          file,
          path,
          message: `le renvoi ${value} désigne un ensemble de clés, pas un texte`,
          hint: 'un *_key doit pointer vers une chaîne ou une liste de lignes',
        }),
      );
    }
  }
}

/**
 * Chaque couleur nommée d'un gabarit existe dans la palette. La palette est une
 * donnée de configuration : la figer dans le schéma en ferait une valeur codée
 * en dur, c'est donc ici qu'elle se vérifie.
 */
function checkTemplateColors(embeds, errors) {
  if (!isRecord(embeds) || !isRecord(embeds.templates)) return;

  const palette = isRecord(embeds.colors) ? Object.keys(embeds.colors) : [];

  for (const [name, template] of Object.entries(embeds.templates)) {
    if (!isRecord(template)) continue;

    const { color } = template;
    if (typeof color !== 'string' || HEX.test(color)) continue;

    if (!palette.includes(color)) {
      errors.push(
        new ConfigError({
          file: CONFIG_FILES.embeds,
          path: ['templates', name, 'color'],
          message: `couleur absente de la palette : ${color}`,
          hint:
            palette.length > 0
              ? `couleurs déclarées : ${palette.join(', ')}`
              : 'la section colors est absente ou illisible',
        }),
      );
    }
  }
}

/** Parcourt l'arbre en profondeur, en rendant chaque feuille avec son chemin. */
function* walk(node, path = []) {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) yield* walk(item, [...path, String(index)]);
    return;
  }

  if (isRecord(node)) {
    for (const [key, value] of Object.entries(node)) yield* walk(value, [...path, key]);
    return;
  }

  yield { path, value: node };
}

/** Résout un chemin pointé dans un arbre. `undefined` si une étape manque. */
function resolve(tree, dotted) {
  return dotted
    .split('.')
    .reduce((node, part) => (isRecord(node) ? node[part] : undefined), tree);
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const isText = (value) =>
  typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
