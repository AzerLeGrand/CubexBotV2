import { z } from 'zod';

import { ConfigError } from './errors.js';
import { envFile } from '../../utils/paths.js';

const ENV_FILE_NAME = '.env';
const HINT = `renseigner la clé dans ${ENV_FILE_NAME}, sur le modèle de ${ENV_FILE_NAME}.example`;

/**
 * Secrets attendus (socle §5.7). Rien d'autre n'a sa place ici : un réglage
 * fonctionnel dans .env échappe à la validation des YAML et au rechargement à
 * chaud.
 *
 * Le format de DISCORD_CLIENT_ID n'est pas vérifié à ce stade — il le sera par
 * snowflake(), avec les autres identifiants Discord.
 */
const EnvSchema = z.object({
  DISCORD_TOKEN: z
    .string({ error: "jeton de l'application Discord absent" })
    .min(1, "jeton de l'application Discord vide"),
  DISCORD_CLIENT_ID: z
    .string({ error: "identifiant de l'application Discord absent" })
    .min(1, "identifiant de l'application Discord vide"),
  NODE_ENV: z.enum(['production', 'development'], {
    error: (issue) =>
      issue.input === undefined
        ? 'environnement d\'exécution absent'
        : "environnement d'exécution inconnu — attendu : production ou development",
  }),
});

/**
 * Charge et valide les secrets.
 *
 * Ne lève pas et n'arrête pas le processus : l'appelant décide, comme pour les
 * fichiers YAML, de sorte qu'un démarrage puisse présenter d'un coup les
 * anomalies de .env et celles des YAML.
 *
 * @param {object} [options]
 * @param {string} [options.file]   chemin du fichier .env
 * @param {object} [options.source] variables d'environnement à valider
 * @returns {{ env: object | null, errors: ConfigError[] }}
 */
export function loadEnv({ file = envFile, source = process.env } = {}) {
  const errors = [];

  try {
    process.loadEnvFile(file);
  } catch (cause) {
    // Fichier absent : toléré. Les variables peuvent venir de l'environnement
    // du processus (unité systemd, écosystème pm2). La validation ci-dessous
    // signalera celles qui manquent réellement.
    if (cause.code !== 'ENOENT') {
      errors.push(
        new ConfigError({
          file: ENV_FILE_NAME,
          message: `fichier illisible : ${cause.message}`,
          hint: `vérifier les droits de lecture sur ${file}`,
        }),
      );
    }
  }

  // safeParse écarte tout ce qui n'est pas déclaré : le reste de l'application
  // ne voit que ces trois clés, jamais process.env dans son entier.
  const result = EnvSchema.safeParse(source);

  if (!result.success) {
    for (const issue of result.error.issues) {
      errors.push(
        new ConfigError({
          file: ENV_FILE_NAME,
          path: issue.path.map(String),
          message: issue.message,
          hint: HINT,
        }),
      );
    }
  }

  return { env: result.success ? result.data : null, errors };
}
