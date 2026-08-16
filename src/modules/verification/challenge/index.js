import { AppError } from '../../../core/errors/app-error.js';

import { createImageChallenge } from './image.js';

/**
 * L'épreuve de vérification : une interface, des implémentations.
 *
 * La spec pose l'épreuve comme interchangeable — `image` livrée, `web` prévue et
 * non écrite. D'où cette indirection d'une dizaine de lignes : sans elle, le
 * jour où `web` s'écrit, il faudrait désentrelacer le rendu de la logique de
 * tentatives, et personne ne le ferait.
 *
 * Le moteur ne connaît que trois méthodes, aucune ne parlant d'image :
 *
 * | Méthode | Rôle |
 * |---|---|
 * | `prepare()` | vérifie que l'implémentation peut fonctionner, au démarrage |
 * | `issue()` | rend `{ secret, attachment }` — le secret à comparer, ce que le membre reçoit |
 * | `accepts(secret, saisie)` | normalise et compare |
 *
 * Une implémentation `web` rendrait un lien en `attachment` et validerait un
 * jeton dans `accepts()`, sans que `engine.js` change d'une ligne.
 */

const IMPLEMENTATIONS = Object.freeze({ image: createImageChallenge });

/**
 * Construit l'épreuve déclarée par la configuration.
 *
 * Le type est lu une seule fois, à la construction : en changer suppose de
 * reconstruire le module, donc un redémarrage. C'est sans conséquence pratique
 * — le schéma n'admet aujourd'hui que `image`, précisément pour qu'on ne
 * configure pas une implémentation qui n'existe pas.
 */
export function createChallenge({ config, logger }) {
  const type = config.get('verification.challenge.type');
  const build = IMPLEMENTATIONS[type];

  if (build === undefined) {
    // Le schéma l'aurait déjà refusé : arriver ici signifie que le schéma et
    // cette table ont divergé, ce qui est un défaut du code.
    throw new AppError(`type d'épreuve sans implémentation : ${type}`, {
      code: 'challenge_unsupported',
      context: { type, available: Object.keys(IMPLEMENTATIONS) },
      expected: false,
    });
  }

  return build({ config, logger });
}
