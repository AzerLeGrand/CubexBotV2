/**
 * Module de journalisation Discord (phase 2).
 *
 * Enregistrement et restitution des événements du serveur : suppressions de
 * messages, mouvements vocaux, arrivées et départs, changements de structure,
 * actions de modération.
 *
 * **Ce lot branche les deux premières familles**, membres et modération. Le
 * module déclare ses tables, ce qu'il confie aux registres de purge et
 * d'effacement, ses références Discord, monte le dépôt d'écriture, pose ses
 * écouteurs de passerelle et branche ses accès Discord une fois connecté. Les
 * familles messages, vocal et serveur, le rattrapage et la commande de
 * consultation arrivent aux lots suivants.
 *
 * **discord.js n'est importé que sous `./discord/`.** Ce fichier assemble et ne
 * traduit rien : il ne connaît la bibliothèque que par les fonctions que ce
 * dossier lui rend.
 */

import { createAuditCache, verifyAuditActions } from './audit.js';
import { createBatcher } from './batching.js';
import { logChannelCapability, LOG_CHANNELS, MODULE_NAME } from './constants.js';
import { createCorrelator } from './correlation.js';
import { createDiscordAccess, createDiscordListeners } from './discord/index.js';
import { createDispatcher } from './dispatcher.js';
import { createExclusions } from './exclusions.js';
import { createPendingQueue } from './pending.js';
import { createRecorder } from './recorder.js';
import { createRenderer } from './render.js';
import { createLogRepository } from './repository.js';
import { createRouter } from './router.js';

export const name = MODULE_NAME;

/**
 * Migrations du module, numérotées pour lui seul : `logs/001`,
 * `verification/001` et `core/001` coexistent sans se gêner, la table de suivi
 * les distingue par leur propriétaire.
 */
export const migrations = './migrations';

/**
 * Rétention (spec §9).
 *
 * Deux tables, deux durées, et c'est la raison d'être de leur séparation : le
 * contenu des messages part à 30 jours, les métadonnées restent à 90.
 *
 * L'ordre d'inscription est celui de l'exécution. Le contenu passe en premier :
 * la suppression d'un événement entraîne celle de son contenu par CASCADE, et
 * l'ordre inverse ferait compter des lignes déjà parties dans le compte rendu.
 */
export const retention = [
  {
    table: 'log_message_content',
    date_column: 'created_at',
    retention_key: 'logs.retention.message_content_days',
  },
  {
    table: 'log_events',
    date_column: 'occurred_at',
    retention_key: 'logs.retention.structural_days',
  },
];

/**
 * Droit à l'effacement (socle §10).
 *
 * Trois déclarations, deux stratégies, et le critère est toujours le même : qui
 * est le sujet de la ligne.
 *
 * `log_message_content.author_id` est SUPPRIMÉ. Le contenu d'un message **est**
 * la donnée personnelle : il ne garde aucune valeur une fois son auteur retiré,
 * et l'anonymiser laisserait le texte intact sous un identifiant neutre — donc
 * n'effacerait rien de ce qui compte.
 *
 * `log_events.actor_id` et `log_events.target_id` sont ANONYMISÉS. Les
 * métadonnées d'un événement gardent leur valeur de trace sans leur porteur :
 * qu'un salon ait été supprimé le 3 mars reste vrai et utile. Surtout, `delete`
 * sur `actor_id` supprimerait les lignes visant D'AUTRES MEMBRES — celles où ce
 * modérateur est intervenu — et effacerait donc les données de gens qui n'ont
 * rien demandé.
 *
 * Les deux colonnes passent le garde-fou du socle : ni l'une ni l'autre ne porte
 * de contrainte d'unicité. La seule de `log_events` est `id`, et l'unique index
 * du module porte sur `audit_log_entry_id`, qui n'est déclaré nulle part ici.
 *
 * L'ordre compte, comme pour la purge : le contenu part avant les métadonnées,
 * pour qu'un CASCADE ne fausse pas le décompte des lignes touchées.
 */
export const erasure = [
  { table: 'log_message_content', user_column: 'author_id', strategy: 'delete' },
  { table: 'log_events', user_column: 'actor_id', strategy: 'anonymize' },
  { table: 'log_events', user_column: 'target_id', strategy: 'anonymize' },
];

/**
 * Aucune commande à ce lot.
 *
 * Déclarée explicitement plutôt que laissée à l'implicite du chargeur : la
 * commande `/history` est attendue, et un export vide dit qu'elle n'est pas
 * encore là.
 */
export const commands = [];

/**
 * Assemblage monté par `init()`, consommé par les lots suivants.
 *
 * État de module plutôt que valeur rendue : le chargeur du noyau ignore ce que
 * `init()` retourne, et un écouteur déclaré dans `events` ne reçoit que le
 * contexte du noyau — jamais l'assemblage interne du module.
 */
let repository = null;
let recorder = null;
let pending = null;
let dispatcher = null;

/**
 * Accès à Discord, injecté APRÈS la connexion.
 *
 * `init()` tourne avant que le client ne soit connecté : ni le journal d'audit,
 * ni les rôles d'un membre, ni l'identifiant du bot n'existent encore. Le module
 * se monte quand même et fonctionne en mode dégradé explicite — aucune
 * corrélation, aucune exclusion par rôle, tout en `unknown` — jusqu'à ce que
 * `ready()` appelle `attach()`.
 *
 * Dégradé, jamais silencieux : `init()` le journalise une fois au démarrage.
 *
 * **Remis à zéro par `init()`**, qui ne tourne qu'au démarrage et toujours avant
 * la connexion : l'état de Discord à ce moment-là EST celui-ci. Un `/reload` ne
 * rejoue pas `init()` et ne débranche donc rien.
 */
const discord = { fetchEntries: null, resolveRoles: null, botUserId: null, send: null };

/** Les quatre accès, dans l'ordre où le message d'erreur les nomme. */
const ACCESS_KEYS = Object.freeze(['fetchEntries', 'resolveRoles', 'botUserId', 'send']);

/**
 * Branche les accès Discord une fois le client connecté.
 *
 * **Tout est obligatoire, et rien n'est optionnel par commodité.** Un accès
 * manquant ne produirait aucune erreur : le module continuerait d'écrire en
 * base, sans corréler, sans exclure par rôle ou sans rien envoyer, et personne
 * ne s'en apercevrait avant d'aller chercher un événement qui n'a jamais été
 * affiché. Le mode dégradé doit rester la situation d'AVANT la connexion, jamais
 * le résultat d'un câblage incomplet.
 *
 * @param {object} access
 * @param {(query: { actionName: string, limit: number }) => Promise<object[]>} access.fetchEntries
 * @param {(userId: string) => Promise<string[]>} access.resolveRoles
 * @param {string} access.botUserId  `client.user.id`, jamais une clé de config
 * @param {(message: object) => Promise<unknown>} access.send envoi d'un message
 * @param {Record<string, unknown>} access.auditActions `AuditLogEvent` de discord.js
 * @throws {TypeError} accès manquant, ou nom d'action inconnu de la bibliothèque
 */
export function attach({ fetchEntries, resolveRoles, botUserId, send, auditActions }) {
  const access = { fetchEntries, resolveRoles, botUserId, send };
  const missing = ACCESS_KEYS.filter((key) => access[key] === null || access[key] === undefined);

  if (missing.length > 0) {
    throw new TypeError(
      `accès Discord manquants au branchement : ${missing.join(', ')} — les quatre sont ` +
        'exigés, un module à moitié branché tournerait en dégradé sans le dire',
    );
  }

  // **Vérification OBLIGATOIRE, et non plus conditionnelle.** Sans l'énumération,
  // aucun nom de `AUDIT_ACTIONS` ne pourrait être confronté à la bibliothèque :
  // la table entière serait inopérante, chaque événement conclurait `unknown`, et
  // rien ne le signalerait — la panne exacte que ce contrôle existe pour fermer.
  //
  // Vérifié ICI et pas ailleurs : `constants.js` est lu à l'étape 0 et n'importe
  // pas discord.js, donc rien avant ce point ne peut faire la confrontation.
  if (auditActions === null || auditActions === undefined) {
    throw new TypeError(
      "énumération des actions d'audit exigée au branchement : sans elle AUDIT_ACTIONS " +
        'ne peut être vérifiée, et tout le module tournerait en unknown sans le dire',
    );
  }

  verifyAuditActions(auditActions);

  discord.fetchEntries = fetchEntries;
  discord.resolveRoles = resolveRoles;
  discord.botUserId = botUserId;
  discord.send = send;

  return discord;
}

/** @returns {object|null} `null` tant qu'`init()` n'a pas tourné. */
export const getRepository = () => repository;

/**
 * Point d'entrée unique de la journalisation, pour les lots suivants.
 *
 * Les écouteurs passeront par `record()` et jamais par le dépôt : c'est ce qui
 * garantit qu'aucune écriture n'échappe à la normalisation ni à la bascule
 * d'activation.
 *
 * @returns {((input: object) => object|null)|null}
 */
export const getRecorder = () => recorder;

/** File d'attente des écritures différées. Exposée pour le vidage et les tests. */
export const getPending = () => pending;

/** File de groupement et d'envoi. Exposée pour le vidage et les tests. */
export const getDispatcher = () => dispatcher;

/**
 * Écouteurs de passerelle, familles membres et modération.
 *
 * Le recorder leur est passé par une FONCTION et non par valeur : cet export est
 * évalué à l'import du module, bien avant qu'`init()` ne l'ait monté. Même motif
 * que `createComponents({ engine: getEngine })` du module de vérification.
 *
 * Le noyau pose ces écouteurs AVANT la connexion, et `ready()` ne branche
 * Discord qu'après. Un événement reçu dans cet intervalle est donc écrit en
 * dégradé — en `unknown`, sans envoi. C'est le bon compromis : attendre pour
 * poser les écouteurs ferait manquer ce qui arrive pendant la séquence de
 * démarrage, et un événement manqué ne se rattrape pas.
 *
 * `clientReady` n'y figurera jamais : il est réservé au noyau, qui enchaîne
 * l'enregistrement des commandes puis la vérification des références.
 */
export const events = createDiscordListeners({ recorder: getRecorder });

/**
 * Monte le dépôt, l'aiguillage et l'orchestration, avant la connexion.
 *
 * Les requêtes SQL sont préparées ici et non à l'usage : une faute de SQL se
 * découvre ainsi au démarrage, pas au premier message supprimé. Le routeur, lui,
 * ne lit RIEN maintenant — il interroge la configuration à chaque appel, sans
 * quoi un `/reload` resterait sans effet sur l'aiguillage.
 */
export function init(ctx) {
  const logger = ctx.logger.forModule(name);
  const config = ctx.config;

  // Le module démarre débranché, toujours. `init()` s'exécute avant `login()` :
  // l'état de Discord à cet instant EST celui-là, et l'écrire plutôt que le
  // supposer évite qu'un montage suivi d'aucun `attach()` hérite du précédent.
  for (const key of ACCESS_KEYS) discord[key] = null;

  repository = createLogRepository({ database: ctx.database });

  const router = createRouter({ config, capabilities: ctx.capabilities });

  // Adaptateurs vers Discord. Ils consultent `discord` à CHAQUE appel plutôt que
  // de capturer sa valeur : `attach()` n'a pas encore eu lieu, et figer un
  // `null` ici laisserait le module dégradé pour toujours.
  //
  // Le mode dégradé est silencieux à l'usage, et c'est voulu : sans journal
  // d'audit, chaque événement conclut `unknown` — le signaler à chaque fois
  // noierait le fichier. L'état est dit une fois, au démarrage.
  const auditCache = createAuditCache({
    fetchEntries: async (query) =>
      discord.fetchEntries === null ? [] : discord.fetchEntries(query),
    config,
    logger,
  });

  const correlator = createCorrelator({ auditCache, config, logger });

  const exclusions = createExclusions({
    config,
    resolveRoles: async (userId) =>
      discord.resolveRoles === null ? [] : discord.resolveRoles(userId),
    botUserId: () => discord.botUserId,
    logger,
  });

  const renderer = createRenderer({ embeds: ctx.embeds, config, logger });

  dispatcher = createDispatcher({
    // Même adaptateur tardif que les trois autres accès : sans `attach()`, le
    // module écrit en base et n'envoie rien.
    send: async (message) => {
      if (discord.send === null) return null;

      return discord.send(message);
    },
    renderer,
    batcher: createBatcher({ embeds: ctx.embeds, logger }),
    config,
    logger,
  });

  // La file appelle le recorder, que la file compose : l'indirection casse le
  // cycle sans rendre l'assemblage conditionnel.
  //
  // **C'est ici que le dispatcher se branche**, sur la valeur de retour de
  // `write()` — le point prévu au lot 2. Tout ce qui est écrit passe par là, y
  // compris ce que le vidage d'arrêt écrit sans corréler : un événement écrit
  // et jamais restitué serait invisible pour le staff.
  pending = createPendingQueue({
    delayMs: () => config.get('logs.audit.write_delay_ms'),
    onDue: async (payload, options) => {
      const written = await recorder.write(payload, options);

      if (written !== null) dispatcher.enqueue(written);

      return written;
    },
    logger,
  });

  recorder = createRecorder({ repository, router, correlator, exclusions, pending, logger });

  // Vidage à l'arrêt, sans plafond explicite : celui du socle suffit largement,
  // et l'invariant du §3 veut la somme des plafonds sous `kill_timeout`.
  //
  // **L'ORDRE DE CES INSCRIPTIONS PORTE UNE GARANTIE, ET C'EST LE SEUL ENDROIT
  // QUI LA PORTE.**
  //
  // La règle : la séquence d'arrêt du socle déroule ses étapes À L'ENVERS de
  // leur inscription. Inscrire en premier, c'est donc partir en dernier.
  //
  // Ce qu'elle impose : un consommateur s'inscrit AVANT son producteur, pour
  // s'exécuter APRÈS lui. Ici, le dispatcher consomme ce que la file d'écriture
  // produit — un événement doit être écrit avant d'être envoyé — donc le
  // dispatcher passe en premier à l'inscription. L'ordre inverse laisserait les
  // derniers événements en base sans jamais les afficher.
  //
  // Pour qui ajoute une étape : la placer AVANT toutes celles dont elle
  // consomme le travail, et APRÈS toutes celles qui consomment le sien. Un
  // rattrapage qui alimente la file d'écriture s'inscrit donc APRÈS elle, pour
  // s'être vidé avant qu'elle ne parte.
  //
  // Un événement encore en attente quand le bot s'arrête n'existe NULLE PART
  // ailleurs : Discord ne le rejouera pas.
  ctx.shutdown?.register(`${name}:dispatch`, () => dispatcher.flush());
  ctx.shutdown?.register(name, () => pending.flush());

  logger.info('journalisation Discord montée', {
    last_event_at: repository.lastEventAt(),
    message_content_days: config.get('logs.retention.message_content_days'),
    structural_days: config.get('logs.retention.structural_days'),
    write_delay_ms: config.get('logs.audit.write_delay_ms'),
    window_seconds: config.get('logs.grouping.window_seconds'),
    // Dit une fois, jamais répété : tant que `attach()` n'a pas eu lieu, aucune
    // corrélation ni exclusion par rôle n'est possible, rien n'est envoyé, et
    // tout part en `unknown`. C'est l'état normal entre `init()` et la
    // connexion — les lignes continuent d'être écrites en base.
    discord_attached: discord.fetchEntries !== null,
    sending: discord.send !== null,
  });
}

/**
 * Branche les accès Discord, une fois le client connecté.
 *
 * Dans `ready(ctx)` et non dans un écouteur `clientReady` : celui-ci partirait
 * en parallèle de la séquence du noyau, avant la vérification des références.
 * Le noyau refuse d'ailleurs cette déclaration.
 *
 * Le serveur est RÉCUPÉRÉ ICI, depuis le client : le contexte du noyau porte
 * `client` mais pas `guild` — seule la connexion peut le résoudre, et chaque
 * consommateur le demande donc au moment où il en a besoin. `bot.guild_id`
 * n'existe qu'une fois, en configuration.
 *
 * Un échec est journalisé par l'enveloppe du noyau et n'arrête pas le
 * démarrage : le module reste alors en dégradé — il écrit sans corréler et sans
 * envoyer — plutôt que d'empêcher le bot de tourner.
 */
export async function ready(ctx) {
  const logger = ctx.logger.forModule(name);

  const access = await createDiscordAccess({
    client: ctx.client,
    guildId: ctx.config.get('bot.guild_id'),
    logger,
  });

  attach(access);

  logger.info('journalisation Discord branchée', {
    bot: access.botUserId,
    listeners: events.length,
  });
}

/**
 * Capacités et références Discord dont elles dépendent (socle §5.5).
 *
 * Une par salon de restitution, et **aucune n'est critique**, délibérément.
 *
 * C'est la garantie centrale de la spec §5 : l'écriture en base doit continuer
 * même quand la restitution dans Discord est impossible. Un salon supprimé par
 * mégarde ne doit pas faire taire le module entier — le bot continuerait alors
 * de tourner sans plus rien enregistrer, et le trou dans l'historique ne se
 * découvrirait qu'en cherchant autre chose. Marquer `critical` ici échangerait
 * une gêne d'affichage contre une perte de données.
 *
 * Dérivées de `LOG_CHANNELS` plutôt qu'écrites une à une : le routeur interroge
 * ces mêmes identifiants par `logChannelCapability()`, et deux listes séparées
 * finiraient par diverger. Une capacité jamais déclarée est considérée ACTIVE
 * par le registre — la divergence produirait donc un `deliverable: true` sur un
 * salon supprimé, le contraire de ce que ces déclarations servent à dire.
 */
export const capabilities = LOG_CHANNELS.map((key) => ({
  id: logChannelCapability(key),
  critical: false,
  refs: [{ kind: 'channel', path: `logs.channels.${key}` }],
}));
