/**
 * Module de journalisation Discord (phase 2).
 *
 * Enregistrement et restitution des événements du serveur : suppressions de
 * messages, mouvements vocaux, arrivées et départs, changements de structure,
 * actions de modération.
 *
 * **Ce lot pose les fondations et ne capte aucun événement.** Le module déclare
 * ses tables, ce qu'il confie aux registres de purge et d'effacement, ses
 * références Discord, et monte le dépôt d'écriture. Les écouteurs, le
 * groupement des envois, le rattrapage et la commande de consultation arrivent
 * aux lots suivants : rien n'est encore visible sur le serveur.
 */

import { createAuditCache, verifyAuditActions } from './audit.js';
import { createBatcher } from './batching.js';
import { logChannelCapability, LOG_CHANNELS, MODULE_NAME } from './constants.js';
import { createCorrelator } from './correlation.js';
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
 * Aucune commande et aucun écouteur à ce lot.
 *
 * Déclarés explicitement plutôt que laissés à l'implicite du chargeur : la
 * capture des événements et la commande `/history` sont attendues, et un export
 * vide dit qu'elles ne sont pas encore là.
 *
 * `clientReady` n'y figurera jamais : il est réservé au noyau, qui enchaîne
 * l'enregistrement des commandes puis la vérification des références. Ce qui
 * doit tourner au démarrage une fois l'API disponible ira dans `ready(ctx)`.
 */
export const commands = [];
export const events = [];

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
 * corrélation, aucune exclusion par rôle, tout en `unknown` — jusqu'à ce que le
 * lot 5 appelle `attach()`.
 *
 * Dégradé, jamais silencieux : `init()` le journalise une fois au démarrage.
 */
const discord = { fetchEntries: null, resolveRoles: null, botUserId: null, send: null };

/**
 * Branche les accès Discord une fois le client connecté (lot 5).
 *
 * @param {object} access
 * @param {(query: { actionName: string, limit: number }) => Promise<object[]>} access.fetchEntries
 * @param {(userId: string) => Promise<string[]>} access.resolveRoles
 * @param {string} access.botUserId  `client.user.id`, jamais une clé de config
 * @param {(message: object) => Promise<unknown>} access.send envoi d'un message
 * @param {Record<string, unknown>} [access.auditActions] `AuditLogEvent`, vérifié si fourni
 */
export function attach({ fetchEntries, resolveRoles, botUserId, send, auditActions = null }) {
  // Vérifié ICI et pas ailleurs : `constants.js` est lu à l'étape 0 et n'importe
  // pas discord.js, donc rien avant ce point ne peut confronter nos noms
  // d'action à l'énumération de la bibliothèque. Un nom inconnu lève.
  if (auditActions !== null) verifyAuditActions(auditActions);

  discord.fetchEntries = fetchEntries ?? null;
  discord.resolveRoles = resolveRoles ?? null;
  discord.botUserId = botUserId ?? null;
  discord.send = send ?? null;

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
  // **L'ORDRE DES DEUX INSCRIPTIONS PORTE UNE GARANTIE.** La séquence d'arrêt
  // déroule ses étapes à l'envers de leur inscription : le dispatcher inscrit en
  // premier part donc en dernier, après la file d'écriture. Les événements
  // encore en attente sont ainsi écrits ET enfilés avant qu'on ne tente de les
  // envoyer. L'ordre inverse les laisserait en base sans jamais les afficher.
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
