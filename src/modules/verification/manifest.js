import { z } from 'zod';

import {
  duration,
  hexColor,
  relativePath,
  snowflake,
  subsection,
} from '../../core/config/schema/primitives.js';

/**
 * Manifeste du module de vérification (phase 1, §10).
 *
 * Ce fichier ne fait que déclarer. Il est lu à l'étape 0 du démarrage, avant
 * les secrets et avant la configuration : ni logger, ni base, ni `config` n'y
 * sont accessibles. Les seuls imports du noyau admis sont les primitives de
 * schéma, de simples fabriques zod — c'est par elles que passent les
 * identifiants Discord, jamais par un `z.string()` nu.
 */

/**
 * Type d'épreuve.
 *
 * `web` est prévu par la spec mais n'est pas écrit : l'accepter ici ferait
 * démarrer un bot qui ne vérifierait personne, sans que rien ne le signale. La
 * clé s'ouvrira le jour où l'implémentation existera.
 */
const challengeType = () =>
  z.enum(['image'], { error: "type d'épreuve attendu : image (web est prévu mais pas écrit)" });

const BAD_ALPHABET =
  "alphabet du code attendu : au moins 10 caractères distincts — en deçà, le nombre de codes " +
  'possibles s\'effondre, et un caractère répété fausse le tirage';

/**
 * Alphabet dans lequel le code est tiré.
 *
 * L'exclusion des caractères ambigus — `0`, `O`, `1`, `I`, `l` — n'est PAS
 * imposée ici : la spec la veut configurable, et la figer dans le schéma
 * interdirait de l'ajuster à l'usage. Seul ce qui ne peut être qu'une faute est
 * refusé : un alphabet trop court, et un caractère répété.
 */
const alphabet = () =>
  z
    .string({ error: BAD_ALPHABET })
    .min(10, BAD_ALPHABET)
    .refine((value) => new Set(value).size === value.length, { error: BAD_ALPHABET });

/** Compte d'éléments de bruit. Zéro est licite : une image sans bruit se règle ainsi. */
const count = () =>
  z.int({ error: 'entier positif ou nul attendu' }).min(0, 'entier positif ou nul attendu');

const BAD_POSITIVE = 'entier strictement positif attendu';

/**
 * Dimension, taille ou seuil. Distinct de `duration()`, dont le message parle
 * d'une unité de temps : un `width: 0` refusé au motif qu'une « durée » est
 * attendue enverrait chercher l'erreur au mauvais endroit.
 */
const positive = () => z.int({ error: BAD_POSITIVE }).positive(BAD_POSITIVE);

const BAD_DISTORTION = 'déformation attendue : un nombre de 0 (aucune) à 1 (maximale)';

const distortion = () =>
  z.number({ error: BAD_DISTORTION }).min(0, BAD_DISTORTION).max(1, BAD_DISTORTION);

const BAD_CODE_LENGTH =
  'longueur de code attendue : de 4 à 12 caractères — en deçà le code se devine, au-delà il ' +
  "devient illisible sur l'image et pénible à saisir";

const codeLength = () =>
  z.int({ error: BAD_CODE_LENGTH }).min(4, BAD_CODE_LENGTH).max(12, BAD_CODE_LENGTH);

/**
 * Paramètres de rendu de l'image (spec §4).
 *
 * Tous configurables : les valeurs seront affinées visuellement une fois la
 * première image produite, et une couleur ou une taille figée dans le code
 * imposerait un déploiement à chaque ajustement.
 */
const ImageSchema = subsection({
  width: positive(),
  height: positive(),
  // Aucune police n'est garantie présente sur une Debian minimale : elle est
  // versionnée dans le dépôt. Le chemin est jugé de la même façon sur les deux
  // plateformes — voir relativePath().
  font_path: relativePath(),
  font_size: positive(),
  background: hexColor(),
  text_color: hexColor(),
  noise_lines: count(),
  noise_dots: count(),
  distortion: distortion(),
});

/**
 * Normalisation de la saisie (spec §4).
 *
 * Un membre qui lit correctement l'image ne doit pas échouer sur une majuscule
 * ou sur un espace collé par le correcteur automatique d'un téléphone.
 */
const InputSchema = subsection({
  case_sensitive: z.boolean({ error: 'bascule attendue : true ou false' }),
  strip_whitespace: z.boolean({ error: 'bascule attendue : true ou false' }),
});

const ChallengeSchema = subsection({
  type: challengeType(),
  code_length: codeLength(),
  ttl_seconds: duration(),
  alphabet: alphabet(),
  // Seul réglage purement technique de la section, donc le seul à porter un
  // défaut : le balayage retire les codes expirés de la mémoire, sa fréquence
  // ne change rien à ce que voit un membre. Tout le reste — identifiants,
  // seuils, rétention — doit être écrit, son absence bloque le démarrage.
  sweep_interval_seconds: duration().default(60),
  input: InputSchema,
  image: ImageSchema,
});

/**
 * Salon et rôles des deux alertes (spec §5).
 *
 * Le salon est commun aux deux : perdu, les deux alertes se taisent. Chaque
 * rôle ne concerne que la sienne.
 */
const AlertSchema = subsection({
  channel_id: snowflake(),
  exhausted_role_id: snowflake(),
  failure_role_id: snowflake(),
});

/**
 * Section `verification` de `config.yml`.
 *
 * Le nom de la section est celui du dossier du module : le noyau ne prend pas
 * de déclaration de nom, ce qui rend toute collision impossible entre modules.
 */
export const schema = z.strictObject({
  channel_id: snowflake(),
  member_role_id: snowflake(),

  challenge: ChallengeSchema,

  // Un seuil, donc sans défaut lui non plus. Cinq n'est pas une résistance au
  // force brute — six caractères sur trente et un font près d'un milliard de
  // combinaisons — mais une coupure de l'automatisation et un signal sur un
  // membre en difficulté.
  max_attempts: positive(),

  alert: AlertSchema,

  // Clé propre au module plutôt qu'un renvoi vers la section `logs` de la
  // phase 2 : un fragment ne valide que sa propre section, et lire dans une
  // section qui n'existe pas encore rendrait la capacité silencieusement
  // inactive jusque-là (spec §12.1).
  log: subsection({ channel_id: snowflake() }),

  // Sans défaut, comme toute rétention : un défaut silencieux, c'est une donnée
  // personnelle conservée plus longtemps que prévu sans que personne ne le
  // sache.
  retention: subsection({ history_days: duration() }),
});

/**
 * `GuildMembers` est privilégié et s'active dans le portail développeur ; à
 * défaut, Discord refuse la connexion sans dire lequel manque — le noyau le
 * nomme dans son diagnostic. `GuildMessages` couvre la republication du message
 * d'accueil s'il est supprimé, et n'est pas privilégié.
 */
export const intents = ['GuildMembers', 'GuildMessages'];
