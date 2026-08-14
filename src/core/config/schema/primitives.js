import { z } from 'zod';

import { isAbsolutePath } from '../../../utils/paths.js';

/**
 * Briques de validation communes aux trois fichiers de configuration.
 *
 * Chaque export est une fabrique et non un schéma partagé : un appelant peut
 * ainsi resserrer une contrainte sans que sa modification ne se propage aux
 * autres usages.
 */

// ---------------------------------------------------------------------------
// Identifiants Discord
// ---------------------------------------------------------------------------

/** 17 chiffres pour les plus anciens comptes, 20 en réserve de croissance. */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

/**
 * Le message ne cite jamais la valeur reçue : js-yaml a converti l'identifiant
 * en nombre et tronqué ses derniers chiffres avant que la validation ne le
 * voie. L'afficher désignerait une valeur qui ne figure nulle part dans le
 * fichier et enverrait chercher l'erreur au mauvais endroit.
 */
const NOT_QUOTED =
  'identifiant Discord écrit sans guillemets — au-delà de 16 chiffres, ' +
  'un nombre YAML est tronqué silencieusement à la lecture ; entourer la valeur de guillemets';

const NOT_A_STRING = 'identifiant Discord attendu : une chaîne de 17 à 20 chiffres, entre guillemets';

const BAD_FORMAT = 'identifiant Discord mal formé : 17 à 20 chiffres, sans espace ni signe';

/**
 * Identifiant Discord — rôle, salon, catégorie, membre, serveur.
 *
 * Aucun rattrapage : ni z.coerce.string(), ni .transform(), ni .trim(). Une
 * valeur convertie serait déjà fausse, et l'accepter reproduirait la panne qui
 * a arrêté la version précédente du bot.
 */
export const snowflake = () =>
  z
    .string({
      error: (issue) => (typeof issue.input === 'number' ? NOT_QUOTED : NOT_A_STRING),
    })
    .regex(SNOWFLAKE_PATTERN, BAD_FORMAT);

// ---------------------------------------------------------------------------
// Permissions de commande
// ---------------------------------------------------------------------------

/** Littéral ouvrant une commande à tous. Comparé par le routage, jamais réécrit. */
export const PUBLIC = 'public';

const EMPTY_ROLES =
  `liste de rôles vide — pour ouvrir la commande à tous, écrire le littéral "${PUBLIC}"`;

const BAD_ROLES =
  `liste d'identifiants de rôles non vide, ou le littéral "${PUBLIC}" pour ouvrir à tous`;

/**
 * Rôles autorisés sur une commande (socle §8.2).
 *
 * La liste vide est refusée : vidée par erreur d'édition, elle ouvrirait /ban à
 * @everyone sans le moindre message. Les deux messages nomment le littéral,
 * pour que la correction soit lisible quelle que soit la branche que zod
 * signale.
 */
export const allowedRoles = () =>
  z.union([z.array(snowflake()).min(1, EMPTY_ROLES), z.literal(PUBLIC)], { error: BAD_ROLES });

// ---------------------------------------------------------------------------
// Sous-sections
// ---------------------------------------------------------------------------

/**
 * Sous-section obligatoire d'un fragment de module.
 *
 * `buildConfigSchema()` applique déjà ce traitement à la RACINE d'un fragment,
 * pour la même raison et avec le même effet : `.prefault({})` substitue puis
 * parse, ce qui produit la liste des clés manquantes plutôt qu'un unique
 * « expected object » posé sur le groupe entier ; et `null` est normalisé parce
 * que js-yaml le rend — et non `undefined` — pour une clé dont l'en-tête est
 * écrit et le corps vide :
 *
 *     retention:
 *
 * Le geste d'édition est le même à toutes les profondeurs — on écrit l'en-tête,
 * on est interrompu — et le diagnostic doit l'être aussi. Sans cela, seule la
 * racine d'une section bénéficie du message utile.
 *
 * @param {Record<string, object>} shape clés de la sous-section
 */
export const subsection = (shape) =>
  z.preprocess((value) => (value === null ? undefined : value), z.strictObject(shape).prefault({}));

// ---------------------------------------------------------------------------
// Chemins
// ---------------------------------------------------------------------------

const BAD_PATH =
  "chemin relatif à la racine du projet attendu — un chemin absolu ne survivrait pas au passage " +
  'du poste de développement au VPS';

const BAD_SEPARATOR =
  'séparateur de chemin non portable : utiliser / plutôt que \\, Node l\'accepte sur les deux ' +
  'plateformes alors qu\'un antislash devient un caractère ordinaire du nom de fichier sous Linux';

/**
 * Chemin de fichier ou de dossier, résolu depuis la racine par `fromRoot()`.
 *
 * `config.yml` est versionné et partagé entre le poste Windows et le VPS
 * Debian : la même valeur doit être jugée de la même façon des deux côtés. La
 * détection d'un chemin absolu couvre donc les deux conventions, et le
 * séparateur est imposé — voir `isAbsolutePath()`.
 *
 * Vit ici et non dans le schéma du noyau : les fragments des modules en ont
 * besoin aussi — le chemin de la police du captcha est lu par les deux
 * plateformes au même titre que celui de la base.
 */
export const relativePath = () =>
  z
    .string({ error: BAD_PATH })
    .min(1, BAD_PATH)
    .refine((value) => !isAbsolutePath(value), { error: BAD_PATH })
    .refine((value) => !value.includes('\\'), { error: BAD_SEPARATOR });

// ---------------------------------------------------------------------------
// Durées
// ---------------------------------------------------------------------------

const BAD_DURATION =
  "durée attendue : un entier strictement positif — l'unité est portée par le nom de la clé " +
  '(ttl_seconds, history_days)';

/**
 * Délai ou durée de rétention.
 *
 * Zéro est refusé au même titre qu'une valeur négative : sur une rétention, il
 * signifierait une purge de tout l'historique à la première exécution nocturne.
 */
export const duration = () => z.int({ error: BAD_DURATION }).positive(BAD_DURATION);

// ---------------------------------------------------------------------------
// Couleurs
// ---------------------------------------------------------------------------

const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

/** Clé de palette : minuscules, chiffres et tirets bas — `brand`, `success`. */
const PALETTE_REF_PATTERN = /^[a-z][a-z0-9_]*$/;

const BAD_HEX =
  'couleur hexadécimale attendue : un dièse suivi de six chiffres hexadécimaux (#F60321)';

const BAD_COLOR =
  'couleur attendue : une clé de la palette de embeds.yml (brand, success, error, info) ' +
  'ou un hexadécimal à six chiffres (#F60321)';

/**
 * Couleur littérale. Réservée à la définition de la palette elle-même, qui ne
 * peut pas se désigner par ses propres clés.
 */
export const hexColor = () => z.string({ error: BAD_HEX }).regex(HEX_PATTERN, BAD_HEX);

/**
 * Couleur d'embed.
 *
 * Ne vérifie que la forme. Qu'une clé de palette existe réellement dans
 * embeds.yml relève de la validation croisée : la palette est une donnée de
 * configuration, la figer ici en ferait une valeur codée en dur.
 */
export const color = () =>
  z.union([hexColor(), z.string().regex(PALETTE_REF_PATTERN)], { error: BAD_COLOR });

// ---------------------------------------------------------------------------
// Références vers messages.yml
// ---------------------------------------------------------------------------

const MESSAGE_KEY_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

const BAD_MESSAGE_KEY =
  'clé de message attendue : un chemin pointé vers messages.yml, ' +
  'par exemple tickets.categories.game.name';

/**
 * Renvoi d'un champ de config.yml vers un texte de messages.yml (convention
 * `*_key`). L'existence de la clé est vérifiée par la validation croisée, qui
 * seule a les deux fichiers sous la main.
 */
export const messageKey = () =>
  z.string({ error: BAD_MESSAGE_KEY }).regex(MESSAGE_KEY_PATTERN, BAD_MESSAGE_KEY);
