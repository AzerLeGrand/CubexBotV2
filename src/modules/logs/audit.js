import { AUDIT_ACTION_NAMES, COUNTED_AUDIT_ACTIONS } from './constants.js';

/**
 * Cache des entrées du journal d'audit.
 *
 * **Aucun import de discord.js.** `fetchEntries` est injecté au câblage, et
 * c'est ce qui rend tout ce fichier testable sans réseau ni jeton. Le
 * branchement réel sur `guild.fetchAuditLogs` appartient au lot 5.
 *
 * Raison d'être : éviter un appel d'API par événement. Une purge de cent
 * messages produit cent événements de passerelle en une seconde ; sans cache
 * elle produirait cent requêtes, que Discord limiterait bien avant la fin.
 *
 * **Le journal d'audit est un ENRICHISSEMENT, jamais une dépendance.** Rien ici
 * ne lève : une requête en échec rend une liste vide, la corrélation conclut
 * `unknown`, et l'événement est écrit quand même. Perdre l'auteur est un
 * désagrément, perdre l'événement serait une faute.
 */

/**
 * Entrée normalisée, telle que `fetchEntries` doit la rendre.
 *
 * @typedef {object} AuditEntry
 * @property {string} id
 * @property {string} actionName   nom d'`AuditLogEvent`, jamais son entier
 * @property {string|null} executorId
 * @property {string|null} targetId
 * @property {string|null} channelId
 * @property {number} count        1 pour les actions sans compteur
 * @property {Date} createdAt
 * @property {object} [extra]
 */

/**
 * Vérifie que chaque nom de `AUDIT_ACTIONS` existe dans l'énumération.
 *
 * L'énumération est PASSÉE, jamais importée : ce module doit rester utilisable
 * sans discord.js. Le câblage du lot 5 lui donnera `AuditLogEvent`.
 *
 * Lève plutôt que d'avertir. Un nom inconnu produit `undefined` à la résolution,
 * et une requête sur `undefined` ne rend rien : la journalisation continuerait en
 * attribuant `unknown` à tout un type d'événement, sans qu'aucune erreur ne le
 * signale. C'est exactement la panne qu'on ne voit jamais.
 *
 * @param {Record<string, unknown>} enumeration `AuditLogEvent` de discord.js
 * @returns {Record<string, number>} nom → valeur, prêt pour l'API
 */
export function verifyAuditActions(enumeration) {
  const unknown = AUDIT_ACTION_NAMES.filter((name) => typeof enumeration?.[name] !== 'number');

  if (unknown.length > 0) {
    throw new Error(
      `actions du journal d'audit inconnues de la bibliothèque : ${unknown.join(', ')} — ` +
        'AUDIT_ACTIONS a divergé de AuditLogEvent, probablement après une montée de version',
    );
  }

  return Object.fromEntries(AUDIT_ACTION_NAMES.map((name) => [name, enumeration[name]]));
}

export function createAuditCache({ fetchEntries, config, logger }) {
  /** @type {Map<string, { entries: object[], fetchedAt: number, inFlight: Promise|null }>} */
  const byAction = new Map();

  /**
   * Dernier compteur vu, par identifiant d'entrée, avec la date de l'observation.
   *
   * Discord ne crée pas une entrée par message supprimé : un même modérateur
   * supprimant plusieurs messages du même auteur dans le même salon INCRÉMENTE
   * une entrée existante. Comparer le compteur au précédent est le seul moyen de
   * savoir qu'une entrée déjà vue correspond à un nouvel acte.
   *
   * La date sert à borner la carte : sans elle, un bot qui tourne trois semaines
   * garderait un compteur par entrée d'audit jamais revue.
   */
  const counts = new Map();

  const windowMs = () => config.get('logs.audit.correlation_window_seconds') * 1000;

  const state = (actionName) => {
    if (!byAction.has(actionName)) {
      byAction.set(actionName, { entries: [], fetchedAt: 0, inFlight: null });
    }

    return byAction.get(actionName);
  };

  /**
   * Écarte ce qui est trop vieux pour être corrélé.
   *
   * Une entrée antérieure à la fenêtre ne peut être candidate pour aucun
   * événement à venir : la garder ne ferait que faire croître le cache.
   *
   * Les entrées à venir sont conservées : l'horloge de Discord et la nôtre ne
   * sont pas synchronisées à la milliseconde, et une entrée « dans le futur » de
   * quelques dizaines de millisecondes est parfaitement ordinaire.
   */
  const withinWindow = (entries, now) =>
    entries.filter((entry) => now - entry.createdAt.getTime() <= windowMs());

  /**
   * Marque ce qui a bougé depuis le rafraîchissement précédent.
   *
   * `isNew` — jamais vue. `increased` — déjà vue, compteur plus haut. Les deux
   * signifient « un nouvel acte a eu lieu » ; ni l'un ni l'autre, l'entrée est un
   * reste du passage précédent et ne doit candidater pour rien.
   */
  function mark(entries, now) {
    const marked = entries.map((entry) => {
      const previous = counts.get(entry.id);
      const count = entry.count ?? 1;

      return {
        ...entry,
        count,
        isNew: previous === undefined,
        increased: previous !== undefined && count > previous.count,
      };
    });

    for (const entry of marked) counts.set(entry.id, { count: entry.count, seenAt: now });

    // Bornage de la carte des compteurs, sur la même fenêtre que les entrées.
    for (const [id, seen] of counts) {
      if (now - seen.seenAt > windowMs()) counts.delete(id);
    }

    return marked;
  }

  async function refresh(actionName, held) {
    try {
      const fetched = await fetchEntries({
        actionName,
        limit: config.get('logs.audit.fetch_limit'),
      });

      const now = Date.now();

      held.entries = mark(withinWindow(fetched ?? [], now), now);
      held.fetchedAt = now;

      return held.entries;
    } catch (cause) {
      // `warn` et non `error` : le journal d'audit peut être indisponible pour
      // des raisons parfaitement ordinaires — permission « View Audit Log »
      // retirée, limitation de débit, coupure réseau. Aucune n'est un défaut du
      // bot, et aucune ne doit empêcher l'écriture de l'événement.
      logger.warn("lecture du journal d'audit impossible", {
        action: actionName,
        error: cause,
      });

      // Les entrées connues sont ÉCARTÉES, pas conservées : après un échec on ne
      // sait plus ce que contient le journal, et servir un état ancien
      // reviendrait à attribuer un événement d'après une photo périmée. En cas
      // de doute, `unknown`.
      //
      // `fetchedAt` est tout de même avancé : sans cela, chaque événement
      // relancerait une requête vers une API qui vient de refuser, et une
      // limitation de débit se transformerait en tempête.
      held.entries = [];
      held.fetchedAt = Date.now();

      return [];
    } finally {
      held.inFlight = null;
    }
  }

  /**
   * Entrées connues pour UNE action, rafraîchies si besoin.
   *
   * Les demandes concurrentes pour la même action partagent une seule requête en
   * vol. Sans cela, dix événements arrivant dans la même milliseconde
   * produiraient dix requêtes identiques — le cache cesserait de servir
   * précisément quand il sert le plus.
   */
  async function entriesOf(actionName) {
    const held = state(actionName);

    if (Date.now() - held.fetchedAt < config.get('logs.audit.refresh_interval_ms')) {
      return held.entries;
    }

    if (held.inFlight !== null) return held.inFlight;

    held.inFlight = refresh(actionName, held);

    return held.inFlight;
  }

  /**
   * Union des entrées de plusieurs actions.
   *
   * Un type d'événement peut en interroger plusieurs : Discord distingue la
   * création, la modification et la suppression pour les permissions de salon
   * comme pour les webhooks, alors que la passerelle n'émet qu'un seul
   * événement. L'union est rendue telle quelle, sans dédoublonnage ni tri — le
   * corrélateur compte les candidates sur l'ensemble, et deux entrées trouvées
   * dans deux actions différentes restent deux candidates, donc `unknown`.
   *
   * Chaque action garde son cache et son partage de requête : demander l'union
   * de trois actions coûte au plus trois requêtes, jamais davantage.
   *
   * @param {readonly string[]} actionNames
   * @returns {Promise<object[]>}
   */
  async function entries(actionNames) {
    if (!Array.isArray(actionNames)) {
      // Forme uniforme, imposée à l'appel : `AUDIT_ACTIONS` ne rend que des
      // listes, et accepter aussi une chaîne créerait deux chemins là où il n'y
      // a qu'une question.
      throw new TypeError("liste de noms d'action attendue par le cache d'audit");
    }

    if (actionNames.length === 0) return [];

    const lists = await Promise.all(actionNames.map((actionName) => entriesOf(actionName)));

    return lists.flat();
  }

  return {
    entries,

    /** L'action porte-t-elle un compteur cumulant plusieurs actes ? */
    isCounted: (actionName) => COUNTED_AUDIT_ACTIONS.includes(actionName),

    /** Actions suivies et compteurs retenus. Pour le diagnostic et les tests. */
    get size() {
      return { actions: byAction.size, counters: counts.size };
    },
  };
}
