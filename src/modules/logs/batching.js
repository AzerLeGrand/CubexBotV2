import { EMBED_LIMITS } from '../../core/embeds/limits.js';

/**
 * Découpage d'un lot d'embeds en messages.
 *
 * Deux plafonds, et le second est le dangereux.
 *
 * **Le nombre d'embeds par message.** Refusé net par l'API, sans ambiguïté.
 *
 * **Le budget cumulé de texte.** Au-delà, **Discord rejette le message ENTIER
 * sans indiquer lequel des embeds déborde.** Le lot ne serait pas tronqué, il ne
 * serait pas affiché du tout — alors que les lignes sont déjà en base. Le
 * journal aurait un trou visible par personne, et la seule trace serait un rejet
 * d'API dans un fichier.
 *
 * Le budget est vérifié par `embeds.fits()` du socle et **jamais recalculé
 * ici** : deux mesures divergeraient, et celle qui se tromperait serait celle
 * qu'on ne teste pas contre l'API.
 *
 * `fits()` est muette, et c'est ce qui permet de l'interroger en boucle. Le
 * découpage est journalisé ici même, en `debug` : couper un lot trop long est un
 * fonctionnement sain, et l'annoncer comme une anomalie noierait les vraies.
 */

export function createBatcher({ embeds, logger }) {
  /**
   * Répartit des embeds en messages.
   *
   * Un embed qui dépasse le budget **à lui seul** part dans son propre message.
   * Le moteur du socle a déjà tronqué ses textes aux limites de champ et l'a
   * journalisé : poser ici un second garde-fou concurrent ferait deux endroits
   * qui coupent, deux journaux, et deux occasions de diverger.
   *
   * @param {object[]} list embeds, dans l'ordre d'arrivée
   * @returns {object[][]} un tableau par message à envoyer
   */
  function splitBatch(list) {
    const messages = [];
    let current = [];

    for (const embed of list) {
      if (current.length === 0) {
        current.push(embed);
        continue;
      }

      // Le plafond de nombre d'abord : il ne coûte rien à vérifier, et le
      // vérifier après ferait appeler `fits()` pour rien.
      const full = current.length >= EMBED_LIMITS.embeds;

      // `fits()` est une MESURE et se tait : c'est ici, où la décision se
      // prend, que le découpage est journalisé — et en `debug`, parce que
      // couper un lot trop long est un fonctionnement sain, pas une anomalie.
      if (full || !embeds.fits([...current, embed]).ok) {
        messages.push(current);
        current = [embed];
        continue;
      }

      current.push(embed);
    }

    if (current.length > 0) messages.push(current);

    if (messages.length > 1) {
      logger.debug('lot découpé en plusieurs messages', {
        embeds: list.length,
        messages: messages.length,
      });
    }

    return messages;
  }

  return { splitBatch };
}
