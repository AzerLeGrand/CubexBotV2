/**
 * File d'attente des événements avant écriture.
 *
 * Elle existe pour une seule raison : **Discord n'inscrit l'entrée d'audit
 * qu'APRÈS avoir émis l'événement de passerelle.** Écrire aussitôt reçu, c'est
 * écrire « auteur inconnu » sur des actions parfaitement attribuables. Le délai
 * vient de `logs.audit.write_delay_ms`.
 *
 * Ce n'est PAS le groupement d'affichage du §5, qui viendra au lot 4 et porte
 * sur les envois. Ici on diffère l'ÉCRITURE de quelques centaines de
 * millisecondes ; là-bas on regroupera des envois sur plusieurs secondes.
 */

export function createPendingQueue({ delayMs, onDue, logger }) {
  /**
   * Délai courant, relu à chaque dépôt.
   *
   * Une fonction est acceptée autant qu'un nombre : le câblage passe un
   * accesseur vers `logs.audit.write_delay_ms`, sans quoi un `/reload` qui
   * change ce réglage resterait sans effet jusqu'au redémarrage. Les tests, eux,
   * passent un nombre.
   */
  const wait = () => (typeof delayMs === 'function' ? delayMs() : delayMs);

  /** @type {{ payload: object, dueAt: number, resolve: Function, reject: Function }[]} */
  let items = [];

  let timer = null;

  /**
   * Chaîne de traitement, pour sérialiser les vidages.
   *
   * L'ordre d'arrivée doit être préservé jusqu'en base : deux événements traités
   * en parallèle s'inséreraient dans un ordre arbitraire, et la relecture
   * chronologique d'un incident deviendrait fausse.
   */
  let chain = Promise.resolve();

  function arm() {
    if (timer !== null || items.length === 0) return;

    timer = setTimeout(() => {
      timer = null;
      void drain(false);
    }, Math.max(0, items[0].dueAt - Date.now()));

    // Un événement en attente ne doit jamais maintenir le processus en vie : la
    // séquence d'arrêt appelle `flush()`, ce minuteur n'a rien à retenir.
    timer.unref?.();
  }

  /**
   * Traite ce qui est dû, ou tout si `all`.
   *
   * @param {boolean} all vidage forcé — l'arrêt, où l'on n'attend plus rien
   */
  function drain(all) {
    chain = chain.then(async () => {
      const now = Date.now();

      while (items.length > 0 && (all || items[0].dueAt <= now)) {
        const item = items.shift();

        try {
          // `correlate: false` au vidage forcé : à l'arrêt, interroger le journal
          // d'audit demanderait un aller-retour réseau sur un client qu'on est en
          // train de fermer. Mieux vaut un `unknown` écrit qu'un événement perdu.
          item.resolve(await onDue(item.payload, { correlate: !all }));
        } catch (cause) {
          // Un échec n'empêche JAMAIS les suivants : une seule ligne fautive ne
          // doit pas emporter la file entière. Le message dit ce que cette
          // journalisation-ci apprend — que la file a continué — l'échec
          // lui-même étant déjà relaté par `onDue`.
          logger.error('événement différé en échec, la file continue', { error: cause });

          item.reject(cause);
        }
      }
    });

    return chain.then(() => {
      arm();
    });
  }

  return {
    /**
     * Place un événement, traité après `delayMs`.
     *
     * @returns {Promise<unknown>} ce que rend `onDue` pour CET événement
     */
    push(payload) {
      return new Promise((resolve, reject) => {
        items.push({ payload, dueAt: Date.now() + wait(), resolve, reject });
        arm();
      });
    },

    /**
     * Vide la file immédiatement, sans corrélation.
     *
     * Inscrit auprès de la séquence d'arrêt : un événement encore en attente
     * quand le bot s'arrête n'existe nulle part ailleurs, et Discord ne le
     * rejouera pas.
     */
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }

      return drain(true);
    },

    get size() {
      return items.length;
    },
  };
}
