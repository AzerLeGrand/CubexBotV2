import { TYPE_PROMOTIONS } from './constants.js';
import { createLogEvent } from './event.js';

/**
 * Point d'entrée unique du module.
 *
 * Tout ce qui journalise passe par `record()` : les écouteurs du lot 5, le
 * rattrapage du lot 7. **Aucun n'écrit directement dans le dépôt.** Un second
 * chemin d'écriture contournerait la normalisation, le contrôle du contenu dans
 * `data`, la bascule d'activation et les exclusions — et il le ferait en
 * silence.
 *
 * L'ordre est le fond du fichier, pas un détail :
 *
 *   1. valider    — un seul composant décide de ce qu'est un type valide ;
 *   2. activation — sur un événement déjà connu valide ;
 *   3. raccourci  — la modification d'un message du bot, seul cas tranché sans
 *                   corrélation ;
 *   4. différer   — Discord n'inscrit l'entrée d'audit qu'APRÈS l'événement ;
 *   5. puis, à l'échéance : corréler, filtrer, écrire, aiguiller.
 *
 * **L'écriture ne consulte JAMAIS `routing.deliverable`.** Un salon supprimé,
 * une capacité tombée, un envoi impossible : la ligne part en base quand même.
 * C'est la garantie du §5, tenue depuis le lot 2, et elle ne tient qu'à cet
 * ordre.
 */

export function createRecorder({ repository, router, correlator, exclusions, pending, logger }) {
  /**
   * Re-normalise un événement sous le type que la corrélation a établi.
   *
   * **La table `TYPE_PROMOTIONS` est fermée et fait foi.** Une promotion vers un
   * type qui n'y figure pas lève : sans ce garde-fou, un défaut du corrélateur
   * pourrait réécrire n'importe quel événement en n'importe quoi, et la ligne
   * partirait en base sous une nature inventée.
   *
   * @returns {object|null} `null` si le type promu est désactivé en configuration
   */
  function promote(event, input, promotedType) {
    if (TYPE_PROMOTIONS[event.eventType] !== promotedType) {
      throw new TypeError(
        `promotion refusée : ${event.eventType} → ${promotedType} ne figure pas dans ` +
          'TYPE_PROMOTIONS — seules les promotions déclarées sont admises',
      );
    }

    // L'activation est reconsultée sur le NOUVEAU type. Le staff qui coupe
    // `member_kick` ne veut pas d'expulsions journalisées, et l'événement en est
    // une : le laisser passer parce qu'il est arrivé sous l'étiquette
    // `member_leave` contournerait le réglage.
    if (!router.isEnabled(promotedType)) return null;

    return createLogEvent({ ...input, type: promotedType });
  }

  /**
   * Traitement à l'échéance : corrélation, filtrage, écriture, aiguillage.
   *
   * Appelé par la file, jamais directement — sauf par la file elle-même au
   * vidage d'arrêt, où `correlate` vaut `false`.
   *
   * La file transporte l'entrée BRUTE en plus de l'événement normalisé : une
   * promotion de type doit rejouer `createLogEvent()`, dont les contrôles de
   * cohérence dépendent du type.
   *
   * @param {{ input: object, event: object }} payload
   * @param {{ correlate: boolean }} options
   * @returns {Promise<{ id: number, event: object, routing: object } | null>}
   */
  async function write({ input, event }, { correlate = true } = {}) {
    // a. Attribution. Au vidage d'arrêt on ne corrèle pas : interroger le
    //    journal d'audit demanderait un aller-retour réseau sur un client qu'on
    //    est en train de fermer. L'événement garde alors ce que l'appelant avait
    //    établi — souvent `unknown`, parfois `certain` quand la plateforme
    //    désignait déjà l'acteur. Mieux vaut un `unknown` écrit qu'un événement
    //    perdu.
    const { actorId, actorConfidence, promotedType = null } = correlate
      ? await correlator.resolve(event)
      : {
          actorId: event.actorId,
          actorConfidence: event.actorConfidence,
          promotedType: null,
        };

    // b. Exclusions, APRÈS la corrélation et jamais avant. C'est tout le §4 :
    //    si le journal d'audit désigne un tiers non exclu, on journalise — même
    //    dans un salon exclu, même sur un message d'un compte exclu. Filtrer
    //    d'abord rendrait invisibles les actions des modérateurs sur les
    //    messages du bot.
    if (await exclusions.isExcluded(event, { actorId })) return null;

    // c. Promotion de type, quand la corrélation a changé la nature de
    //    l'événement — un départ qui se révèle être une expulsion.
    //
    //    L'événement est RE-NORMALISÉ depuis l'entrée d'origine plutôt que
    //    rafistolé : les règles de cohérence de `createLogEvent()` dépendent du
    //    type — un contenu de message n'est admis que sur trois d'entre eux — et
    //    changer le type sans les rejouer produirait une ligne que la
    //    normalisation aurait refusée.
    const base = promotedType === null ? event : promote(event, input, promotedType);

    if (base === null) return null;

    // La corrélation rend un verdict, elle ne réécrit rien : on dérive un nouvel
    // objet plutôt que de muter celui qu'on a reçu. C'est ce qui garde le
    // corrélateur testable seul et sans effet de bord.
    const stored = { ...base, actorId, actorConfidence };

    let id;

    try {
      id = repository.insertEvent(stored);
    } catch (cause) {
      // Perdre un événement en silence est le pire défaut possible de ce
      // module : la donnée n'existe nulle part ailleurs, Discord ne la rejoue
      // pas, et le trou ne se découvre qu'en cherchant autre chose.
      logger.error("écriture d'un événement de journalisation impossible", {
        type: stored.eventType,
        error: cause,
      });

      throw cause;
    }

    // d. Après l'écriture, jamais avant.
    const routing = router.resolve(stored.eventType);

    // Le lot 4 branchera la file d'envoi sur cette valeur de retour. Rien n'est
    // envoyé ici, et rien ne doit l'être : l'envoi a son propre rythme.
    return { id, event: stored, routing };
  }

  /**
   * Enregistre un événement et dit où il doit partir.
   *
   * **Asynchrone depuis le lot 3** : la promesse ne se résout qu'à l'échéance du
   * délai d'écriture, une fois la corrélation faite.
   *
   * @param {object} input voir `createLogEvent()`
   * @returns {Promise<{ id: number, event: object, routing: object } | null>}
   *   `null` quand l'événement est désactivé, écarté par le raccourci, ou exclu
   */
  async function record(input) {
    let event;

    // 1. Validation, AVANT tout le reste.
    //
    // `createLogEvent()` est le seul composant qui décide de ce qu'est un type
    // valide. Laisser le routeur trancher en premier le ferait lever sur un
    // chemin de configuration absent — donc avant la porte « désactivé » et
    // avant l'écriture — et l'enveloppe d'événements du noyau ne relance pas :
    // elle journalise et poursuit. Un type mal orthographié dans un écouteur
    // ferait alors tomber cet écouteur pour tous ses appels, sans qu'une seule
    // ligne n'atteigne la base.
    try {
      event = createLogEvent(input);
    } catch (cause) {
      // Défaut de programmation, jamais une erreur d'exploitation. Journalisé
      // PUIS relancé — l'avaler laisserait un écouteur cassé passer inaperçu
      // pendant des semaines.
      //
      // Seul le type part au journal, jamais l'entrée : elle porte le contenu du
      // message, et ces journaux partiront vers Discord en phase 6.
      logger.error('événement de journalisation invalide', { type: input?.type, error: cause });
      throw cause;
    }

    // 2. Désactivé en configuration : ni affiché, ni conservé, ni journalisé.
    //    Conserver quatre-vingt-dix jours une donnée personnelle dont personne
    //    n'a demandé la journalisation serait une collecte sans finalité.
    if (!router.isEnabled(event.eventType)) return null;

    // 3. Modification d'un message du bot : seul l'auteur peut modifier son
    //    message, donc l'acteur est connu et c'est nous. Écarté sans corrélation
    //    et sans écriture — c'est la protection contre la boucle.
    //
    //    Ce raccourci ne vaut PAS pour une SUPPRESSION : un modérateur qui
    //    supprime un message du bot doit être journalisé.
    if (exclusions.isBotSelfEdit(event)) return null;

    // 4. En file. La promesse rendue est celle de `write()` pour CET événement.
    //    L'entrée brute voyage avec : une promotion de type la re-normalisera.
    return pending.push({ input, event });
  }

  return { record, write };
}
