import { createLogEvent } from './event.js';

/**
 * Point d'entrée unique du module.
 *
 * Tout ce qui journalise passe par `record()` : les écouteurs du lot 3, le
 * rattrapage du lot suivant. **Aucun n'écrit directement dans le dépôt.** Un
 * second chemin d'écriture contournerait la normalisation, le contrôle du
 * contenu dans `data` et la bascule d'activation — et il le ferait en silence.
 *
 * L'ordre des quatre étapes est le fond du fichier, pas un détail :
 *
 *   1. valider   — un seul composant décide de ce qu'est un type valide ;
 *   2. consulter l'activation — sur un événement déjà connu valide ;
 *   3. écrire    — sans jamais consulter le verdict d'aiguillage ;
 *   4. aiguiller — la ligne est déjà en base quand on cherche où l'afficher.
 *
 * L'écriture AVANT l'aiguillage est la garantie du §5 de la spec, et elle ne
 * tient qu'à cet ordre.
 */

export function createRecorder({ repository, router, logger }) {
  /**
   * Enregistre un événement et dit où il doit partir.
   *
   * @param {object} input voir `createLogEvent()`
   * @returns {{ id: number, event: object, routing: object } | null}
   *   `null` quand l'événement est désactivé en configuration
   */
  return function record(input) {
    let event;

    // 1. Validation, AVANT tout le reste.
    //
    // `createLogEvent()` est le seul composant qui décide de ce qu'est un type
    // valide. Laisser le routeur trancher en premier le ferait lever sur un
    // chemin de configuration absent — donc avant la porte « désactivé » et
    // avant l'écriture — et l'enveloppe d'événements du noyau ne relance pas :
    // elle journalise et poursuit. Un type mal orthographié dans un écouteur
    // ferait alors tomber cet écouteur pour tous ses appels, sans qu'une seule
    // ligne n'atteigne la base, et le seul symptôme serait une ligne d'erreur
    // par occurrence dans un flux qui en contient déjà beaucoup.
    //
    // Le coût est de normaliser un événement qui sera peut-être écarté à
    // l'étape 2. Il est négligeable : rien ici ne touche la base ni le réseau.
    try {
      event = createLogEvent(input);
    } catch (cause) {
      // Défaut de programmation, jamais une erreur d'exploitation : le type, la
      // confiance et la source viennent toutes du code. Journalisé PUIS relancé
      // — l'avaler laisserait un écouteur cassé passer inaperçu pendant des
      // semaines, le relancer sans trace priverait le diagnostic du seul
      // endroit où il est lisible.
      //
      // Seul le type part au journal, jamais l'entrée : elle porte le contenu du
      // message, et ces journaux partiront vers Discord en phase 6.
      logger.error('événement de journalisation invalide', { type: input?.type, error: cause });
      throw cause;
    }

    // 2. Désactivé en configuration : ni affiché, ni conservé, ni journalisé.
    //
    // Ne rien écrire est ici le comportement CORRECT, pas une optimisation.
    // Conserver quatre-vingt-dix jours une donnée personnelle dont personne n'a
    // demandé la journalisation serait une collecte sans finalité — et le staff
    // qui coupe un événement croirait à juste titre qu'il ne laisse plus de
    // trace. Aucune ligne de journal non plus : un événement coupé peut être le
    // plus fréquent du serveur, et le signaler noierait le fichier.
    //
    // La porte ne s'ouvre que sur un événement déjà connu valide : `isEnabled()`
    // lève sur un type inconnu, et ce cas ne peut plus l'atteindre.
    if (!router.isEnabled(event.eventType)) return null;

    let id;

    try {
      id = repository.insertEvent(event);
    } catch (cause) {
      // Perdre un événement en silence est le pire défaut possible de ce
      // module : la donnée n'existe nulle part ailleurs, Discord ne la rejoue
      // pas, et le trou ne se découvre qu'en cherchant autre chose.
      logger.error('écriture d\'un événement de journalisation impossible', {
        type: event.eventType,
        error: cause,
      });
      throw cause;
    }

    // 4. Après l'écriture, jamais avant. Le verdict d'aiguillage ne conditionne
    //    rien de ce qui précède.
    const routing = router.resolve(event.eventType);

    // Le lot 4 branchera la file de groupement sur cette valeur de retour. Rien
    // n'est envoyé ici, et rien ne doit l'être : l'envoi a son propre rythme.
    return { id, event, routing };
  };
}
