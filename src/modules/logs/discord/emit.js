/**
 * Passage des écouteurs vers le point d'entrée du module.
 *
 * **Aucun écouteur n'écrit dans le dépôt.** Tout passe par `record()`, seul
 * chemin qui applique la normalisation, la bascule d'activation, la corrélation
 * et les exclusions. Un second chemin les contournerait toutes, et en silence.
 *
 * Le recorder est reçu par une FONCTION et non par valeur : les écouteurs sont
 * construits à l'import du module, bien avant qu'`init()` ne l'ait monté. Même
 * motif que `createComponents({ engine: getEngine })` du module de vérification.
 */

export function createEmitter({ recorder }) {
  /**
   * Un événement.
   *
   * Rend `null` tant que le module n'est pas monté. Le cas ne se produit pas au
   * démarrage — le noyau appelle `init()` avant de poser les écouteurs — mais un
   * écouteur qui lèverait ici ferait tomber un événement Discord ordinaire sur
   * un défaut d'ordre de câblage.
   */
  const emit = (input) => {
    const held = recorder();

    if (held === null) return Promise.resolve(null);

    return held.record(input);
  };

  /**
   * Plusieurs événements issus d'un même signal de passerelle.
   *
   * **En parallèle, jamais en séquence.** Chaque `record()` ne se résout qu'à
   * l'échéance de `logs.audit.write_delay_ms` : trois rôles attribués d'un coup
   * coûteraient trois fois ce délai enchaînés, et l'arrêt du bot trouverait une
   * file encore pleine pour un geste vieux de deux secondes.
   */
  const emitAll = (inputs) => Promise.all(inputs.map(emit));

  return { emit, emitAll };
}
