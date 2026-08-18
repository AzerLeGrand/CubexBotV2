/**
 * File de groupement et envoi vers Discord.
 *
 * Discord limite le débit d'envoi de messages. Une purge de cent messages ou une
 * arrivée massive en vocal saturerait un envoi par événement — d'où la fenêtre
 * d'accumulation du §5 de la spec, qui s'applique **à tous les salons**, y
 * compris pour un événement isolé. Le léger délai qui en résulte est accepté.
 *
 * **Aucun import de discord.js.** `send` est injecté au câblage, comme
 * `fetchEntries` et `resolveRoles` au lot 3.
 *
 * **Rien ici ne conditionne l'écriture en base.** Quand le dispatcher est
 * appelé, la ligne est déjà écrite : c'est la garantie tenue depuis le lot 2, et
 * elle explique le traitement des échecs ci-dessous.
 */

export function createDispatcher({ send, renderer, batcher, config, logger }) {
  /**
   * Une file PAR SALON.
   *
   * Un salon bruyant — les messages pendant une soirée — ne doit pas retarder
   * les autres : une file unique ferait attendre un bannissement derrière
   * quarante suppressions de messages.
   *
   * @type {Map<string, { records: object[], timer: object|null, draining: Promise|null }>}
   */
  const queues = new Map();

  const queueFor = (channelId) => {
    if (!queues.has(channelId)) queues.set(channelId, { records: [], timer: null, draining: null });

    return queues.get(channelId);
  };

  function arm(channelId, queue) {
    if (queue.timer !== null) return;

    // La fenêtre est lue à CHAQUE ouverture, jamais au montage : un `/reload`
    // qui la change doit prendre effet sans redémarrage.
    const windowMs = config.get('logs.grouping.window_seconds') * 1000;

    queue.timer = setTimeout(() => {
      queue.timer = null;
      void drain(channelId);
    }, windowMs);

    // Un lot en attente ne doit jamais maintenir le processus en vie : la
    // séquence d'arrêt appelle `flush()`.
    queue.timer.unref?.();
  }

  /**
   * Rend un lot, le découpe, et l'envoie.
   *
   * Le choix du rendu se fait ici et non à l'enfilement : le nombre
   * d'événements de la fenêtre n'est connu qu'à sa fermeture.
   */
  async function deliver(channelId, records) {
    const compact = records.length > config.get('logs.grouping.compact_threshold');

    let embeds;
    let attachments;

    if (compact) {
      const rendered = renderer.renderCompact(records);

      embeds = [rendered.embed];
      attachments = rendered.attachments;
    } else {
      const rendered = records.map((record) => renderer.renderRich(record));

      embeds = rendered.map((held) => held.embed);
      attachments = rendered.map((held) => held.attachment).filter((held) => held !== null);
    }

    const messages = batcher.splitBatch(embeds);

    for (const [index, batch] of messages.entries()) {
      try {
        await send({
          channelId,
          embeds: batch,
          // Les pièces jointes accompagnent le PREMIER message du lot : elles
          // se rapportent à l'ensemble, et les répartir demanderait de savoir
          // quel embed a produit quel fichier — une correspondance que le
          // découpage par budget ne conserve pas.
          attachments: index === 0 ? attachments : [],
        });
      } catch (cause) {
        // **Journalisé et ABANDONNÉ.** Aucune reprise, aucune file persistante.
        //
        // Deux raisons, et la première suffit : la donnée n'est PAS perdue, elle
        // est en base. Réessayer après un redémarrage produirait en plus des
        // doublons dans le salon, sans qu'aucun moyen ne permette de les
        // distinguer d'événements réels.
        //
        // `warn` et non `error` : un salon supprimé ou une permission retirée
        // n'est pas un défaut du bot.
        logger.warn('envoi vers un salon de journalisation impossible', {
          channel: channelId,
          embeds: batch.length,
          error: cause,
        });
      }
    }
  }

  /**
   * Vide la file d'un salon.
   *
   * Sérialisé par salon : deux vidages concurrents inverseraient l'ordre des
   * messages, et un journal dont les lignes ne se suivent pas ne sert plus à
   * relire un incident.
   */
  function drain(channelId) {
    const queue = queueFor(channelId);

    queue.draining = (queue.draining ?? Promise.resolve()).then(async () => {
      const records = queue.records;

      if (records.length === 0) return;

      queue.records = [];

      try {
        await deliver(channelId, records);
      } catch (cause) {
        // Défaillance du rendu ou du découpage, pas de l'envoi : celui-ci a son
        // propre traitement. Un salon en échec n'empêche jamais les autres.
        logger.error('rendu d\'un lot de journalisation impossible', {
          channel: channelId,
          events: records.length,
          error: cause,
        });
      }
    });

    return queue.draining;
  }

  return {
    /**
     * Met un événement déjà écrit en file d'envoi.
     *
     * @param {{ id: number, event: object, routing: object }} record retour de `record()`
     */
    enqueue(record) {
      if (record === null || record === undefined) return;

      const { routing } = record;

      // Salon injoignable : rien n'est mis en file. La ligne est en base, et
      // c'est tout ce qui compte — accumuler pour un salon qui n'existe plus
      // ferait croître la mémoire sans jamais rien afficher.
      if (!routing.deliverable) {
        logger.debug('événement écrit mais non restitué', {
          type: record.event.eventType,
          channel: routing.channelKey,
          reason: routing.reason,
        });

        return;
      }

      const queue = queueFor(routing.channelId);

      queue.records.push(record);
      arm(routing.channelId, queue);
    },

    /**
     * Envoie tout immédiatement.
     *
     * Doit s'exécuter APRÈS la file d'écriture du lot 3 : un événement encore en
     * attente d'écriture n'est pas encore enfilé ici, et vider le dispatcher
     * avant lui le laisserait sur le carreau.
     *
     * La séquence d'arrêt du socle déroule ses étapes dans l'ORDRE INVERSE de
     * leur inscription. Le câblage inscrit donc le dispatcher EN PREMIER pour
     * qu'il parte en dernier — voir `index.js`, où l'ordre des deux `register()`
     * est le seul endroit qui porte cette garantie.
     */
    flush() {
      const pending = [];

      for (const [channelId, queue] of queues) {
        if (queue.timer !== null) {
          clearTimeout(queue.timer);
          queue.timer = null;
        }

        pending.push(drain(channelId));
      }

      return Promise.all(pending);
    },

    /** Événements en attente, tous salons confondus. */
    get size() {
      let total = 0;

      for (const queue of queues.values()) total += queue.records.length;

      return total;
    },

    /** Salons ayant une file ouverte. Pour le diagnostic et les tests. */
    get channels() {
      return [...queues.keys()];
    },
  };
}
