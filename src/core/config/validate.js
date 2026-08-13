import { crossReference } from './crossref.js';
import { ConfigError } from './errors.js';
import { CONFIG_FILES } from './loader.js';
import { detectSecrets } from './secrets.js';
import {
  CORE_SECTION_NAMES,
  CoreConfigSchema,
  unknownSections,
} from './schema/core.schema.js';
import { EmbedsSchema } from './schema/embeds.schema.js';
import { MessagesSchema } from './schema/messages.schema.js';

/**
 * Validation complète des trois fichiers (socle §5.4).
 *
 * Les trois passes s'exécutent TOUJOURS, y compris quand la précédente a
 * échoué. Un court-circuit obligerait à redémarrer le bot autant de fois qu'il
 * y a de natures d'anomalies, et masquerait un jeton oublié dans un fichier
 * dont le schéma est par ailleurs invalide.
 *
 * L'ordre des passes va du plus grave au plus fin : un secret versionné se
 * corrige avant une clé mal orthographiée.
 *
 * Ne porte pas les anomalies de chargement : un fichier illisible est signalé
 * par `loadYamlFiles()`, et l'appelant concatène les deux listes avant de
 * décider. Un `data` non nul avec un fichier à `null` signifie donc « rien à
 * redire sur ce qui a pu être lu », pas « configuration complète ».
 *
 * @param {Record<string, object|null>} files arbres bruts issus du chargeur
 * @returns {{ data: object|null, errors: ConfigError[], warnings: ConfigError[], summary: string }}
 */
export function validate(files, options = {}) {
  const {
    configSchema = CoreConfigSchema,
    knownSections = CORE_SECTION_NAMES,
    summary = 'Configuration invalide',
  } = options;

  const errors = [];

  // Passe 1 — secrets, sur les arbres bruts.
  errors.push(...detectSecrets(files));

  // Passe 2 — schéma, fichier par fichier.
  const data = {};
  const schemas = { config: configSchema, messages: MessagesSchema, embeds: EmbedsSchema };

  for (const [key, schema] of Object.entries(schemas)) {
    const tree = files[key];

    // Fichier absent ou illisible : le chargeur l'a déjà signalé, le répéter
    // sous une autre forme n'aiderait personne.
    if (tree === null || tree === undefined) {
      data[key] = null;
      continue;
    }

    const result = schema.safeParse(tree);

    if (result.success) {
      data[key] = result.data;
    } else {
      data[key] = null;
      errors.push(...result.error.issues.map((issue) => fromZodIssue(issue, CONFIG_FILES[key])));
    }
  }

  // Passe 3 — croisée, sur les arbres bruts : reste exécutable quand le schéma
  // a échoué, ce qui est précisément le moment où l'on veut tout voir.
  errors.push(...crossReference(files));

  return {
    data: errors.length === 0 ? data : null,
    errors,
    warnings: orphanSections(files.config, knownSections),
    summary,
  };
}

/**
 * Sections racine qu'aucun schéma ne couvre. Ce sont des avertissements et non
 * des erreurs : une section renseignée avant que son module ne soit écrit doit
 * pouvoir attendre dans le fichier.
 */
function orphanSections(config, knownSections) {
  return unknownSections(config, knownSections).map(
    (section) =>
      new ConfigError({
        file: CONFIG_FILES.config,
        path: [section],
        message: 'section inconnue : aucun schéma ne la déclare',
        hint:
          'tolérée si le module correspondant reste à écrire — sinon, vérifier ' +
          "l'orthographe de la section",
      }),
  );
}

function fromZodIssue(issue, file) {
  const path = issue.path.map(String);

  // zod nomme les clés en trop dans `keys` et non dans `path` : sans ce cas
  // particulier, l'anomalie désignerait la section entière et le message
  // resterait en anglais, seul de son espèce.
  if (issue.code === 'unrecognized_keys') {
    const keys = issue.keys ?? [];

    return new ConfigError({
      file,
      path: [...path, ...keys.slice(0, 1)],
      message:
        keys.length > 1
          ? `clés inconnues dans cette section : ${keys.join(', ')}`
          : 'clé inconnue dans cette section',
      hint: 'une section du noyau n\'accepte que les clés qu\'elle déclare',
    });
  }

  return new ConfigError({ file, path, message: issue.message });
}
