import { z } from 'zod';

import { duration, snowflake, subsection } from '../../core/config/schema/primitives.js';
import { LOG_CHANNELS, LOG_EVENTS } from './constants.js';

/**
 * Manifeste du module de journalisation Discord (phase 2).
 *
 * Lu à l'étape 0 du démarrage, avant les secrets et avant la configuration : ni
 * logger, ni base, ni `config` n'y sont accessibles. Les seuls imports admis
 * sont les primitives de schéma — de simples fabriques zod — et `constants.js`,
 * qui ne fait que déclarer lui aussi. Un identifiant Discord passe par
 * `snowflake()`, jamais par un `z.string()` nu.
 */

const BAD_POSITIVE = 'entier strictement positif attendu';

/**
 * Seuil ou taille. Distinct de `duration()`, dont le message renvoie à une unité
 * de temps portée par le nom de la clé : un `attachment_threshold: 0` refusé au
 * motif qu'une « durée » est attendue enverrait chercher l'erreur ailleurs.
 */
const positive = () => z.int({ error: BAD_POSITIVE }).positive(BAD_POSITIVE);

const BAD_ID_LIST =
  "liste d'identifiants Discord attendue — la liste vide [] est admise et " +
  "signifie « aucune exclusion »";

/**
 * Liste d'exclusion.
 *
 * **La liste vide est délibérément acceptée**, contrairement à `allowedRoles()`
 * du noyau. Le raisonnement de ce dernier est inversé ici : une liste
 * `allowed_roles` vidée par erreur ouvrirait `/ban` à tous, alors qu'une liste
 * d'exclusion vide est l'état neutre et sûr — tout est journalisé, ce que le
 * module est fait pour faire.
 *
 * `null` n'est pas normalisé en `[]`. Écrire `channels:` sans rien dessous est
 * une édition interrompue, pas une intention : la refuser nomme la clé, alors
 * que l'accepter en silence ferait passer un oubli pour un choix.
 */
const idList = () => z.array(snowflake(), { error: BAD_ID_LIST });

/**
 * Salons de restitution (spec §2).
 *
 * Aucun défaut : ce sont des identifiants Discord, et le socle §15 les veut
 * obligatoires. Un salon manquant refuse le démarrage tant qu'il n'est pas
 * écrit ; un salon supprimé sur Discord ne désactive que sa capacité, l'écriture
 * en base continue.
 */
const ChannelsSchema = subsection(
  Object.fromEntries(LOG_CHANNELS.map((key) => [key, snowflake()])),
);

const BAD_CHANNEL_REF =
  `nom de salon attendu : une clé de logs.channels (${LOG_CHANNELS.join(', ')})`;

/**
 * Réglage d'un événement (spec §2).
 *
 * Chaque événement est activable individuellement ET pointe individuellement
 * vers un salon : le regroupement par catégorie n'est qu'une valeur par défaut
 * du fichier livré, jamais une contrainte du schéma.
 */
const EventSchema = subsection({
  enabled: z.boolean({ error: 'bascule attendue : true ou false' }),
  channel: z.string({ error: BAD_CHANNEL_REF }).min(1, BAD_CHANNEL_REF),
});

/**
 * Les événements sont des clés OBLIGATOIRES, une par type déclaré dans
 * `constants.js`.
 *
 * Un `z.record()` ouvert accepterait une faute de frappe — `messsage_delete` —
 * qui produirait un événement silencieusement jamais journalisé, et laisserait
 * le vrai `message_delete` sans réglage. C'est exactement le mode de défaillance
 * que la validation existe pour fermer.
 */
const EventsSchema = subsection(Object.fromEntries(LOG_EVENTS.map((event) => [event, EventSchema])));

/**
 * Section `logs` de `config.yml`.
 *
 * Le nom de la section est celui du dossier du module : le noyau ne prend pas de
 * déclaration de nom, ce qui rend toute collision impossible entre modules.
 */
export const schema = z
  .strictObject({
    channels: ChannelsSchema,
    events: EventsSchema,

    // Réglages purement techniques, donc les seuls à porter un défaut : aucun
    // ne change ce qui est enregistré, seulement la façon dont c'est restitué.
    grouping: subsection({
      // Discord limite le débit d'envoi : une purge de cent messages saturerait
      // un envoi par événement. Un événement isolé part donc avec ce léger
      // délai, ce que la spec §5 accepte explicitement.
      window_seconds: duration().default(5),

      // Nombre d'ÉVÉNEMENTS, jamais une taille : au-delà, la fenêtre part en un
      // seul embed condensé plutôt qu'en un embed par événement. Une purge de
      // cent messages produirait sinon dix messages de dix embeds, qui
      // noieraient le salon pour un seul geste de modération.
      compact_threshold: positive().default(5),
    }),

    // Au-delà de ce nombre de caractères, le contenu part en fichier joint
    // plutôt qu'en troncature (spec §3) : un embed rejeté par l'API est un
    // message qui n'arrive jamais, et une troncature perdrait la fin du message
    // supprimé — c'est-à-dire souvent ce qu'on cherchait.
    attachment_threshold: positive().default(1024),

    audit: subsection({
      // Tolérance de la corrélation avec le journal d'audit (spec §3). Trop
      // large, elle attribue une action au mauvais modérateur ; trop étroite,
      // elle rend « auteur inconnu » sur des cas identifiables. D'où un réglage.
      //
      // À NE JAMAIS CONFONDRE avec write_delay_ms : celui-ci dit combien de
      // temps on ATTEND avant d'écrire, celle-là l'écart maximal accepté ENTRE
      // un événement et une entrée d'audit pour les lier. Les deux se mesurent
      // en temps et ne mesurent pas la même chose.
      correlation_window_seconds: duration().default(5),

      // Délai entre la réception d'un événement et son écriture. Discord
      // n'inscrit l'entrée d'audit qu'APRÈS avoir émis l'événement de
      // passerelle : écrire aussitôt, c'est écrire « auteur inconnu » sur des
      // actions parfaitement attribuables. Trop long, et l'arrêt du bot trouve
      // une file pleine qu'il doit vider sans corrélation.
      write_delay_ms: duration().default(750),

      // Âge au-delà duquel les entrées d'une action sont relues auprès de
      // l'API. C'est ce qui évite une requête par événement : une purge de cent
      // messages doit coûter une requête, pas cent.
      refresh_interval_ms: duration().default(2000),

      // Nombre d'entrées demandées par requête. Au-delà de la fenêtre de
      // corrélation elles ne servent à rien, les plus vieilles étant écartées
      // à la lecture.
      fetch_limit: positive().default(25),

      // Longueur retenue de la raison saisie par le modérateur, reprise du
      // journal d'audit. C'est le SEUL texte libre d'un tiers que le module
      // écrive dans `data`, et il part ensuite dans un embed : le borner évite
      // qu'une raison démesurée mange le budget cumulé d'un message et fasse
      // rejeter tout un lot.
      //
      // 512 par défaut, qui est le plafond de Discord lui-même sur l'en-tête
      // de raison d'audit : la valeur ne coupe donc rien en usage normal. Elle
      // est ici pour le jour où la plateforme changerait d'avis.
      reason_max_length: positive().default(512),
    }),

    catchup: subsection({
      // Un bot arrêté trois semaines ne doit pas déverser trois semaines
      // d'historique au redémarrage (spec §8).
      max_hours: duration().default(24),
    }),

    // Aucun défaut ici, jamais : un défaut silencieux sur une rétention, c'est
    // une donnée personnelle conservée plus longtemps que prévu sans que
    // personne ne le sache (socle §15).
    retention: subsection({
      /** Contenus des messages supprimés ou modifiés. */
      message_content_days: duration(),
      /** Métadonnées : tout ce que porte `log_events`. */
      structural_days: duration(),
    }),

    /**
     * Exclusions (spec §4). L'exclusion porte sur l'AUTEUR DE L'ACTION, jamais
     * sur le message concerné : un modérateur qui supprime un message dans un
     * salon exclu reste journalisé.
     */
    exclusions: subsection({
      channels: idList(),
      users: idList(),
      roles: idList(),
    }),
  })
  /**
   * Validation croisée interne au fragment : chaque événement doit pointer vers
   * un salon qui existe.
   *
   * Un `channel: "modération"` accentué, ou un `moderations` au pluriel, passe
   * toutes les validations de forme et produit un événement dont la restitution
   * ne trouve aucun salon. Sans ce contrôle, on le découvrirait le jour où un
   * bannissement ne remonte nulle part.
   *
   * Le contrôle ne s'exécute que si la section a parsé : zod n'enchaîne pas ses
   * `check` sur une valeur déjà en défaut, donc `channels` et `events` sont ici
   * toujours des objets conformes.
   */
  .superRefine((section, ctx) => {
    const known = Object.keys(section.channels);

    for (const [event, settings] of Object.entries(section.events)) {
      if (known.includes(settings.channel)) continue;

      ctx.addIssue({
        code: 'custom',
        path: ['events', event, 'channel'],
        message:
          `l'événement « ${event} » pointe vers le salon « ${settings.channel} », ` +
          `qui n'est pas une clé de logs.channels (${known.join(', ')})`,
      });
    }
  });

/**
 * Intents de la passerelle.
 *
 * `GuildMembers` et `MessageContent` sont PRIVILÉGIÉS et s'activent dans le
 * portail développeur ; à défaut, Discord refuse la connexion sans dire lequel
 * manque — le noyau les nomme dans son diagnostic.
 *
 * Les trois derniers ne figurent pas dans la table de la spec §11 : c'est une
 * omission. Sans `GuildExpressions`, `GuildWebhooks` et `GuildInvites`, les
 * événements d'émoji, de webhook et d'invitation ne remontent jamais en direct
 * — ils ne seraient rattrapés qu'au redémarrage suivant, par le journal
 * d'audit, ce qui n'est pas une journalisation.
 *
 * `GuildExpressions` est le nom courant du membre de `GatewayIntentBits` ;
 * `GuildEmojisAndStickers` en est l'alias hérité, présent dans la même version
 * de discord.js. Les deux valent le même bit, on écrit le nom courant.
 *
 * **Permission Discord requise en plus des intents :** `View Audit Log`, sans
 * laquelle l'identification des auteurs et le rattrapage sont impossibles. Elle
 * ne se déclare pas ici — c'est un réglage du serveur, pas de la passerelle.
 */
export const intents = [
  'Guilds',
  'GuildMembers',
  'GuildMessages',
  'MessageContent',
  'GuildVoiceStates',
  'GuildModeration',
  'GuildExpressions',
  'GuildWebhooks',
  'GuildInvites',
  'AutoModerationExecution',
];
