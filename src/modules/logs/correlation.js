import { ACTOR_CONFIDENCE, AUDIT_ACTIONS, TYPE_PROMOTIONS } from './constants.js';

/**
 * Attribution de l'auteur d'une action, par corrélation avec le journal d'audit.
 *
 * **La partie la plus délicate du module.** Une attribution fausse s'affiche
 * exactement comme une bonne, personne ne la remarque, et elle alimentera le
 * casier de la phase 3. Deux règles gouvernent tout le fichier :
 *
 * - **En cas de doute, `unknown`.** Un auteur non trouvé est un résultat
 *   correct, pas un échec à rattraper.
 * - **Aucun repli implicite.** Jamais « probablement le dernier modérateur
 *   actif », jamais d'élargissement de fenêtre au cas où.
 *
 * `certain` n'est JAMAIS produit ici. Cette confiance vient de l'appelant, quand
 * la plateforme désigne l'acteur directement — un membre qui rejoint, qui se
 * connecte en vocal, qui modifie son propre message. La corrélation ne peut
 * produire que `probable` ou `unknown`.
 */

/**
 * **`audit_log_entry_id` reste `null` en corrélation directe.**
 *
 * L'incohérence est réelle et se résout ici plutôt que dans la migration. La
 * colonne porte un index UNIQUE, posé au lot 1 pour dédoublonner le rattrapage,
 * et la relation n'y est de un à un que dans ce sens-là.
 *
 * En direct elle ne l'est pas : Discord ne crée pas une entrée par message
 * supprimé. Un même modérateur supprimant plusieurs messages du même auteur dans
 * le même salon INCRÉMENTE le compteur d'une entrée existante. Une seule entrée
 * correspond alors à plusieurs de nos événements, et écrire son identifiant deux
 * fois violerait l'index — l'insertion échouerait, et l'événement serait perdu
 * pour une raison qui n'a rien à voir avec lui.
 *
 * Décision : la corrélation en direct renseigne `actor_id` et
 * `actor_confidence`, et laisse `audit_log_entry_id` à `null`. Seul le
 * rattrapage du lot 7 le renseignera, là où il lit les entrées une à une.
 * L'index garde exactement le rôle pour lequel il a été posé, et SQLite tolère
 * autant de `NULL` qu'on veut dans un index unique.
 */

export function createCorrelator({ auditCache, config, logger }) {
  /**
   * Ce que l'appelant a déjà établi, faute de mieux.
   *
   * `promotedType` est toujours présent, à `null` par défaut : une forme
   * uniforme évite que l'appelant oublie de le lire sur l'un des chemins.
   */
  const asProvided = (event) => ({
    actorId: event.actorId ?? null,
    actorConfidence: event.actorId == null ? ACTOR_CONFIDENCE.unknown : event.actorConfidence,
    promotedType: null,
  });

  const unknown = () => ({
    actorId: null,
    actorConfidence: ACTOR_CONFIDENCE.unknown,
    promotedType: null,
  });

  /**
   * Une entrée peut-elle correspondre à cet événement ?
   *
   * Trois critères, et pas un de plus. Les assouplir améliorerait le taux
   * d'attribution en dégradant sa justesse, ce qui est le mauvais échange :
   * personne ne peut relire un « supprimé par X (probable) » pour vérifier.
   */
  function matches(entry, event, occurredAt, windowMs) {
    // Même cible. Comparaison inconditionnelle : c'est le critère qui porte le
    // plus d'information, et l'omettre quand l'événement n'a pas de cible
    // élargirait le filet exactement là où il est déjà le plus lâche.
    //
    // `correlationTargetId` prime sur `targetId` quand il est fourni : un
    // événement structurel — rôle créé, salon supprimé — a bien une cible
    // d'audit, mais ce n'est pas un membre, et `target_id` est déclaré au
    // registre d'effacement comme colonne de membre. Le champ de corrélation
    // porte cette identité sans la persister.
    const target = event.correlationTargetId ?? event.targetId ?? null;

    if ((entry.targetId ?? null) !== target) return false;

    // Même salon, quand l'événement en a un. Beaucoup d'actions n'en ont pas —
    // un bannissement, une modification du serveur — et exiger l'égalité les
    // écarterait toutes.
    if (event.channelId != null && (entry.channelId ?? null) !== event.channelId) return false;

    // Dans la fenêtre, de part et d'autre : l'entrée d'audit peut être datée
    // légèrement avant ou après l'événement de passerelle, les deux horloges
    // n'étant pas les mêmes.
    return Math.abs(entry.createdAt.getTime() - occurredAt) <= windowMs;
  }

  /**
   * Attribue un auteur, ou déclare ne pas savoir.
   *
   * **Ne lève jamais. Ne modifie pas l'événement.** Elle rend un verdict, et
   * l'appelant décide — sachant que l'appelant écrira de toute façon.
   *
   * @param {object} event événement normalisé par `createLogEvent()`
   * @returns {Promise<{ actorId: string|null, actorConfidence: string,
   *   promotedType: string|null }>} `promotedType` demande au recorder de
   *   re-normaliser l'événement sous un autre type — voir `TYPE_PROMOTIONS`
   */
  async function resolve(event) {
    try {
      const actionNames = AUDIT_ACTIONS[event.eventType] ?? [];

      // 1. Aucune action d'audit pour ce type : aucune requête, et l'on rend ce
      //    que l'appelant a établi. `message_edit` est le cas type — seul
      //    l'auteur peut modifier son message, l'acteur est connu sans rien
      //    demander à personne.
      if (actionNames.length === 0) return asProvided(event);

      // L'appelant tient déjà l'acteur de la plateforme elle-même. Corréler ne
      // pourrait que DÉGRADER `certain` en `probable` : on garde le signal fort.
      // Ce n'est pas un repli, c'est le refus d'en fabriquer un.
      if (event.actorId != null && event.actorConfidence === ACTOR_CONFIDENCE.certain) {
        return asProvided(event);
      }

      // 2. Union des entrées de toutes les actions du type, servie par le cache.
      const entries = await auditCache.entries(actionNames);

      const occurredAt = Date.parse(event.occurredAt);

      if (Number.isNaN(occurredAt)) {
        // `createLogEvent()` garantit un ISO valide : y arriver signifierait que
        // quelqu'un a court-circuité la normalisation.
        logger.warn('horodatage illisible, corrélation abandonnée', { type: event.eventType });
        return unknown();
      }

      const windowMs = config.get('logs.audit.correlation_window_seconds') * 1000;

      // 3. Candidates : même cible, même salon le cas échéant, dans la fenêtre.
      let candidates = entries.filter((entry) => matches(entry, event, occurredAt, windowMs));

      // 4. Actions à compteur : une entrée ne vaut que si elle vient
      //    d'apparaître ou si son compteur a monté. Sans ce filtre, l'entrée
      //    d'une suppression d'hier — encore dans la fenêtre parce que relue à
      //    l'instant — serait recollée à chaque nouvel événement du même
      //    modérateur.
      //
      //    Le filtre porte sur l'action de CHAQUE entrée, pas sur celle du
      //    type : une union peut mêler une action à compteur et une autre sans,
      //    et appliquer le filtre à toutes écarterait des attributions valides.
      candidates = candidates.filter(
        (entry) => !auditCache.isCounted(entry.actionName) || entry.isNew || entry.increased,
      );

      // 5. Le cœur du lot.
      //
      // Aucune candidate : rien ne désigne d'auteur. Discord n'inscrit RIEN
      // quand un membre supprime son propre message — l'absence d'entrée est le
      // cas le plus fréquent, pas une anomalie.
      if (candidates.length === 0) return unknown();

      // Plusieurs candidates : l'attribution est INDÉCIDABLE. Choisir la plus
      // proche dans le temps serait un repli implicite, et il aurait l'air de
      // marcher — deux modérateurs agissant dans la même seconde produiraient
      // une attribution nette et fausse, que personne ne saurait relire.
      //
      // Le compte porte sur l'UNION : deux entrées trouvées dans deux actions
      // différentes — une permission créée et une supprimée dans la même
      // seconde — restent deux candidates, donc `unknown`.
      if (candidates.length > 1) {
        logger.debug('attribution indécidable, plusieurs entrées candidates', {
          type: event.eventType,
          actions: actionNames,
          candidates: candidates.length,
        });

        return unknown();
      }

      const [entry] = candidates;

      if (entry.executorId == null) return unknown();

      // Une seule candidate : `probable`, jamais `certain`. La corrélation reste
      // faillible par construction, et l'affichage doit dire « (probable) ».
      //
      // C'est aussi la SEULE situation où une promotion de type est possible.
      // Trouver une entrée d'expulsion pour un départ prouve que le membre a été
      // expulsé ; plusieurs candidates ne prouvent rien, et un départ mal
      // attribué en expulsion irait dans le salon de modération et alimenterait
      // un casier à tort.
      return {
        actorId: entry.executorId,
        actorConfidence: ACTOR_CONFIDENCE.probable,
        promotedType: TYPE_PROMOTIONS[event.eventType] ?? null,
      };
    } catch (cause) {
      // Le journal d'audit est un enrichissement : une défaillance ici ne doit
      // jamais empêcher l'écriture. On note et on conclut `unknown`.
      logger.warn('corrélation impossible', { type: event?.eventType, error: cause });

      return unknown();
    }
  }

  return { resolve };
}
