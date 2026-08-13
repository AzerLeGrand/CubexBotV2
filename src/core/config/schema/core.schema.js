import { isAbsolute } from 'node:path';

import { z } from 'zod';

import { allowedRoles, duration, snowflake } from './primitives.js';

/**
 * Sections de `config.yml` que le noyau valide et consomme.
 *
 * Le noyau ne déclare que ce qu'il utilise : une clé déclarée est une clé
 * obligatoire, et exiger des identifiants que rien ne lit empêcherait le
 * démarrage sans contrepartie. Le référentiel des rôles du serveur arrive avec
 * le premier module qui en a besoin.
 */

// ---------------------------------------------------------------------------
// Types locaux au noyau
// ---------------------------------------------------------------------------

const BAD_PATH =
  "chemin relatif à la racine du projet attendu — un chemin absolu ne survivrait pas au passage " +
  'du poste de développement au VPS';

/** Chemin de fichier ou de dossier, résolu depuis la racine par `fromRoot()`. */
const relativePath = () =>
  z
    .string({ error: BAD_PATH })
    .min(1, BAD_PATH)
    .refine((value) => !isAbsolute(value), { error: BAD_PATH });

const BAD_TIMEZONE =
  'fuseau horaire IANA inconnu — attendu par exemple Europe/Paris';

/**
 * Fuseau IANA. Vérifié auprès d'Intl plutôt que par une liste : une faute de
 * frappe décalerait la purge nocturne sans que rien ne le signale.
 */
const timezone = () =>
  z.string({ error: BAD_TIMEZONE }).refine(
    (value) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    },
    { error: BAD_TIMEZONE },
  );

/** Heure de la journée. Zéro est minuit : `duration()` ne convient pas ici. */
const hourOfDay = () =>
  z
    .int({ error: 'heure attendue : un entier de 0 à 23' })
    .min(0, 'heure attendue : un entier de 0 à 23')
    .max(23, 'heure attendue : un entier de 0 à 23');

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * Permissions d'une commande. Le noyau n'en déclare qu'une, `reload` ; les
 * commandes des modules sont validées par le catchall, sans que le noyau ait à
 * tenir leur liste.
 */
const CommandSchema = z.strictObject({ allowed_roles: allowedRoles() });

const CORE_SECTIONS = {
  bot: z.strictObject({
    guild_id: snowflake(),
    // Un seul fuseau pour tout le bot : la rotation des journaux et la purge
    // nocturne doivent tomber sur la même journée civile, sinon un fichier et
    // les lignes qu'il décrit se réfèrent à deux jours différents.
    timezone: timezone(),
  }),

  commands: z.object({ reload: CommandSchema }).catchall(CommandSchema),

  database: z.strictObject({
    file: relativePath(),
    // Réglage d'exploitation : il ne protège rien, et sur un disque lent la
    // valeur utile change. `synchronous`, qui garantit la durabilité, reste
    // en dur — le configurer permettrait de le désactiver.
    busy_timeout_ms: duration(),
  }),

  logging: z.strictObject({
    level: z.enum(['error', 'warn', 'info', 'debug'], {
      error: 'niveau attendu : error, warn, info ou debug',
    }),
    directory: relativePath(),
    file_prefix: z
      .string({ error: 'préfixe des fichiers de journal attendu' })
      .regex(/^[a-z][a-z0-9-]*$/, 'préfixe attendu : minuscules, chiffres et tirets'),
    retention_days: duration(),
  }),

  purge: z.strictObject({
    hour: hourOfDay(),
  }),

  minecraft: z.strictObject({
    enabled: z.boolean({ error: 'bascule attendue : true ou false' }),
  }),
};

/** Sections que le noyau sait valider. Sert à repérer les sections orphelines. */
export const CORE_SECTION_NAMES = Object.freeze(Object.keys(CORE_SECTIONS));

/**
 * Racine de `config.yml`.
 *
 * Souple à la racine, stricte à l'intérieur de chaque section. Une section sans
 * fragment déclaré — `tickets:` renseignée avant que le module ne soit écrit —
 * ne doit pas empêcher le démarrage, sans quoi la configuration ne pourrait
 * être préparée qu'au rythme du développement.
 *
 * Le filet contre la faute de frappe reste tendu par ailleurs : toutes les
 * sections ci-dessus étant obligatoires, `purg:` au lieu de `purge:` produit
 * une erreur bloquante de section manquante. `unknownSections()` complète en
 * signalant la clé orpheline.
 */
export const CoreConfigSchema = z.looseObject(CORE_SECTIONS);

/**
 * Sections racine qu'aucun schéma ne couvre. Retournées à l'appelant plutôt
 * que journalisées ici : le module de configuration n'importe pas le logger.
 *
 * @param {object} config arbre brut de config.yml
 * @param {readonly string[]} [known] sections couvertes, noyau et modules réunis
 * @returns {string[]}
 */
export function unknownSections(config, known = CORE_SECTION_NAMES) {
  if (config === null || typeof config !== 'object') return [];

  return Object.keys(config).filter((section) => !known.includes(section));
}
