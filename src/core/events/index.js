import { Events } from 'discord.js';

import { AppError } from '../errors/app-error.js';

/**
 * Écouteurs d'événements Discord déclarés par les modules (socle §4).
 *
 * Ce câblage appartient au noyau, et non à chaque module, pour une raison
 * précise : un `client.on` dont le gestionnaire est asynchrone et rejette
 * produit un `unhandledRejection`, que le gestionnaire d'arrêt traite en
 * défaillance fatale — sortie 1, pm2 redémarre. Sans enveloppe, un message
 * supprimé dans un salon inattendu suffirait à arrêter le bot en production.
 * Laissée aux modules, l'enveloppe serait réécrite à chaque fois, et il
 * suffirait d'un oubli.
 *
 * Forme d'une déclaration :
 *
 *     export const events = [
 *       { name: 'messageDelete', execute: async (ctx, message) => { ... } },
 *     ];
 *
 * LE CONTEXTE VIENT EN PREMIER, à l'inverse des commandes où `execute` reçoit
 * `(interaction, context)`. Ce n'est pas une inconstance : les arguments d'un
 * événement Discord sont variadiques et leur nombre change d'un événement à
 * l'autre — on ne peut pas déclarer un paramètre fixe après un rest. Le
 * contexte est le seul argument dont la position soit connue d'avance.
 */

/**
 * Noms d'événements que discord.js émet réellement.
 *
 * `Events` associe une clé PascalCase à une valeur camelCase — `MessageDelete`
 * → `messageDelete` — et c'est la VALEUR que `client.on()` attend. Le contrôle
 * ne porte donc que sur les valeurs : accepter aussi les clés poserait un
 * écouteur sur un nom que Discord n'émet jamais, jamais appelé et sans la
 * moindre erreur. Or `MessageDelete` est exactement ce qu'écrira quelqu'un qui
 * a `Events.MessageDelete` sous les yeux.
 *
 * Mesuré sur discord.js 14.27 : aucune clé n'égale sa valeur, et aucune valeur
 * n'est par ailleurs une clé. Les deux ensembles étant disjoints, une clé
 * écrite par erreur est reconnaissable, et le refus peut nommer la valeur
 * attendue. Un test verrouille cette disjonction — si une version future la
 * cassait, la suggestion deviendrait trompeuse.
 *
 * Rien à voir avec le piège de `GatewayIntentBits` (manifests.js) : celui-là
 * est une énumération NUMÉRIQUE, donc porteuse d'une correspondance inverse.
 * TypeScript n'en produit pas pour une énumération de chaînes.
 */
const EVENT_NAMES = new Set(Object.values(Events));

/**
 * `clientReady` est réservé au noyau.
 *
 * Sa séquence enchaîne `guilds.fetch`, l'enregistrement des commandes,
 * `verifyDiscordRefs()` puis les `ready(ctx)` des modules. Un écouteur
 * concurrent partirait en parallèle et s'exécuterait avant de savoir si sa
 * capacité est active — un salon supprimé, et le module publie dans le vide.
 * C'est précisément ce que `ready(ctx)` existe pour éviter.
 *
 * Seul `clientReady` est restreint : sur `error` ou `interactionCreate`,
 * plusieurs écouteurs coexistent sans qu'aucun ordre ne soit imposé.
 */
const RESERVED = Events.ClientReady;

/**
 * @param {object} options
 * @param {object} options.logger
 * @param {object} options.capabilities registre des capacités (socle §5.5)
 */
export function createEventRegistry({ logger, capabilities }) {
  /** @type {{ owner: string, name: string, once: boolean, execute: Function }[]} */
  const entries = [];

  /**
   * Inscrit les écouteurs d'un module. Refus bloquant au démarrage : un
   * écouteur mal déclaré ne se remarquerait autrement qu'à son silence.
   */
  function register(owner, list = []) {
    for (const listener of list) {
      const fault = (message) => {
        throw new AppError(`écouteur « ${listener?.name} » de ${owner} : ${message}`, {
          code: 'event_invalid',
          context: { owner, event: listener?.name },
          expected: false,
        });
      };

      if (typeof listener?.name !== 'string') {
        fault("« name » attendu : un nom d'événement de discord.js, tel que messageDelete");
      }

      if (!EVENT_NAMES.has(listener.name)) {
        // La clé PascalCase écrite à la place de la valeur : le cas le plus
        // probable, et le seul qu'on puisse corriger dans le message.
        const suggestion = Object.hasOwn(Events, listener.name)
          ? ` — attendu ${JSON.stringify(Events[listener.name])}`
          : '';

        fault(`événement inconnu de discord.js : ${JSON.stringify(listener.name)}${suggestion}`);
      }

      if (listener.name === RESERVED) {
        fault(
          `« ${RESERVED} » est réservé au noyau — déclarer un export « ready(ctx) », appelé ` +
            'après la vérification des références, quand le module sait si sa capacité est active',
        );
      }

      if (typeof listener.execute !== 'function') fault('« execute » doit être une fonction');

      if (listener.once !== undefined && typeof listener.once !== 'boolean') {
        fault('« once » doit être un booléen');
      }

      entries.push({
        owner,
        name: listener.name,
        once: listener.once ?? false,
        execute: listener.execute,
      });
    }
  }

  /**
   * Pose les écouteurs sur le client.
   *
   * Appelé AVANT `login()` : les poser depuis `clientReady` ferait manquer tout
   * ce qui arrive entre la connexion et l'exécution de la séquence.
   *
   * @param {object} client
   * @param {object} context contexte du noyau, enrichi du module pour chacun
   */
  function attach(client, context) {
    for (const entry of entries) {
      // Le contexte du module est construit une fois, pas à chaque événement :
      // messageDelete sur un serveur actif, c'est plusieurs appels par seconde.
      const moduleContext = { ...context, module: entry.owner };

      const listener = (...args) => {
        // Un module désactivé se tait (socle §5.5) : une référence critique
        // introuvable le laisse chargé — ses migrations s'appliquent — mais il
        // ne réagit plus à rien. Lu à chaque passage et non figé ici : un
        // /reload peut réactiver le module, et l'écouteur doit se remettre à
        // répondre sans qu'on ait à le réattacher.
        //
        // Fenêtre assumée : l'attachement précède la connexion, et
        // verifyDiscordRefs() ne tourne qu'à la fin de clientReady. Pendant ces
        // quelques secondes, isModuleEnabled répond vrai pour un module qui
        // sera désactivé juste après. Attacher plus tard ferait manquer ce qui
        // arrive pendant la séquence — ce n'est pas un oubli, ne pas
        // « corriger » l'ordre.
        if (!capabilities.isModuleEnabled(entry.owner)) return;

        // Aucun journal ici : messageDelete sur un serveur actif remplirait les
        // fichiers de bruit permanent.
        void run(entry, moduleContext, args);
      };

      client[entry.once ? 'once' : 'on'](entry.name, listener);
    }

    logger.info('écouteurs Discord attachés', {
      count: entries.length,
      events: entries.map((entry) => `${entry.owner} → ${entry.name}`),
    });
  }

  /**
   * Exécute un écouteur sans jamais laisser échapper d'erreur.
   *
   * Ne relance rien, dans aucun cas : la relance repartirait en
   * `unhandledRejection`, c'est-à-dire en arrêt du bot. Même discipline que
   * `commands.handle()`, qui ne lève jamais non plus.
   */
  async function run(entry, context, args) {
    try {
      await entry.execute(context, ...args);
    } catch (error) {
      logger.error('écouteur en échec', { module: entry.owner, event: entry.name, error });
    }
  }

  return {
    register,
    attach,

    get size() {
      return entries.length;
    },

    list: () => entries.map(({ owner, name, once }) => ({ owner, name, once })),
  };
}

/**
 * Exécute le `ready(ctx)` de chaque module, à la fin de la séquence de
 * connexion et APRÈS `verifyDiscordRefs()`.
 *
 * `init(ctx)` s'exécute avant `login()` : ni serveur, ni salons, ni rôles. Un
 * module qui doit lire l'API au démarrage — vérifier qu'un message permanent
 * est toujours là, le republier sinon — n'a nulle part où le faire. `ready`
 * comble ce trou sans que le module ait à déclarer un `clientReady`, qui
 * partirait en parallèle de la séquence du noyau.
 *
 * **`ready` ne s'exécute QU'AU DÉMARRAGE.** Un `/reload` revérifie les
 * références et peut réactiver une capacité, mais ne rejoue pas `ready`. Un
 * module qui veut réagir à un rechargement s'abonne à `config.on('reload')`.
 *
 * Une enveloppe par module : un `ready` en échec est journalisé et n'empêche ni
 * les suivants, ni la suite de la séquence — le démarrage de la purge, en
 * particulier, ne dépend d'aucun module.
 *
 * @param {object} options
 * @param {object[]} options.modules  modules normalisés par le chargeur
 * @param {object} options.context    contexte du noyau
 * @param {object} options.capabilities
 * @param {object} options.logger
 */
export async function runReady({ modules, context, capabilities, logger }) {
  for (const module of modules) {
    if (module.ready === null) continue;

    // Le saut porte sur le module entier, jamais sur une capacité isolée : un
    // module dont une capacité NON critique est tombée doit continuer à
    // s'initialiser, seule la capacité concernée se tait. Journalisé, à la
    // différence des écouteurs : c'est une fois par démarrage, et cela explique
    // pourquoi le module n'a rien fait.
    if (!capabilities.isModuleEnabled(module.name)) {
      logger.info('ready ignoré, module désactivé', {
        module: module.name,
        reason: capabilities.moduleReason(module.name),
      });

      continue;
    }

    try {
      await module.ready({ ...context, module: module.name });
    } catch (error) {
      logger.error('ready de module en échec', { module: module.name, error });
    }
  }
}
