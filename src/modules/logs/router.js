import { logChannelCapability, MODULE_NAME } from './constants.js';

/**
 * Aiguillage d'un événement vers son salon de restitution.
 *
 * **Ce fichier DÉCRIT, il n'empêche rien.** C'est la contrainte centrale du
 * module, et elle se perd facilement : l'écriture en base ne consulte jamais
 * `deliverable`. Un salon supprimé, une capacité tombée, un envoi impossible —
 * la ligne part en base quand même. La spec §5 l'exige, l'écriture est immédiate
 * et indépendante de l'affichage, et un incident d'envoi ne doit jamais faire
 * perdre la donnée.
 *
 * Le seul verdict qui empêche quelque chose est `isEnabled()`, et il porte sur
 * une intention explicite du staff : un événement désactivé dans `config.yml`
 * n'est ni affiché ni conservé.
 *
 * **Aucun cache, aucune lecture au démarrage.** La configuration est relue à
 * chaque appel, sans quoi un `/reload` n'aurait aucun effet sur l'aiguillage
 * avant redémarrage — et le rechargement à chaud existe précisément pour éviter
 * ce redémarrage.
 */

export function createRouter({ config, capabilities }) {
  /**
   * L'événement est-il journalisé ?
   *
   * **Lève sur un type inconnu**, délibérément : `config.get()` sans repli
   * refuse un chemin qui ne résout pas, et les 33 types sont des clés
   * obligatoires du schéma. Un chemin absent ne peut donc venir que d'une faute
   * de frappe dans le code appelant, que le message nomme. Se rabattre sur
   * `false` ferait disparaître l'événement en silence — un écouteur entier
   * cesserait de journaliser sans que rien ne le signale.
   */
  const isEnabled = (type) => config.get(`logs.events.${type}.enabled`) === true;

  /**
   * Où cet événement doit-il partir, et le peut-il ?
   *
   * **Ne lève jamais.** Elle rend un verdict, l'appelant décide — et l'appelant
   * a déjà écrit en base quand il l'interroge. Une exception ici ferait échouer
   * un enregistrement pourtant réussi, ce qui est le contraire du but.
   *
   * D'où les replis sur `config.get()` : un type ou une clé de salon qui ne
   * résout pas produit `deliverable: false` avec son motif, jamais une levée.
   *
   * @returns {{ channelKey: string|null, channelId: string|null,
   *             deliverable: boolean, reason: string|null }}
   */
  const resolve = (type) => {
    const channelKey = config.get(`logs.events.${type}.channel`, null);

    if (channelKey === null) {
      return unreachable(null, null, `aucun salon configuré pour l'événement ${type}`);
    }

    const channelId = config.get(`logs.channels.${channelKey}`, null);

    if (channelId === null) {
      // La validation croisée du fragment refuse déjà ce cas au démarrage. Il ne
      // reste atteignable qu'entre un `/reload` et la validation qui le suit ;
      // le traiter coûte trois lignes et évite un `undefined` propagé jusqu'à
      // un appel Discord au lot 4.
      return unreachable(channelKey, null, `logs.channels.${channelKey} est introuvable`);
    }

    const capability = logChannelCapability(channelKey);

    // `isActive` et non `isEnabled` : la seconde ignore l'état du module, et une
    // capacité peut être éteinte par la désactivation en bloc de son
    // propriétaire. Aucune capacité de ce module n'est critique, donc le cas ne
    // se produit pas aujourd'hui — s'appuyer là-dessus le ferait ressurgir le
    // jour où l'une le deviendrait.
    if (capabilities.isActive(capability)) {
      return { channelKey, channelId, deliverable: true, reason: null };
    }

    // Le motif porté par la capacité elle-même, à défaut celui du module : une
    // capacité déclarée après une désactivation en bloc n'a pas de motif propre,
    // et un `deliverable: false` sans raison n'apprend rien à qui lit le journal.
    const reason =
      capabilities.reasonFor(capability) ??
      capabilities.moduleReason(MODULE_NAME) ??
      `capacité ${capability} inactive`;

    return { channelKey, channelId, deliverable: false, reason };
  };

  return { isEnabled, resolve };
}

const unreachable = (channelKey, channelId, reason) => ({
  channelKey,
  channelId,
  deliverable: false,
  reason,
});
