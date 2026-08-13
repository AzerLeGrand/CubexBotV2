import { FeatureUnavailableError } from '../core/errors/app-error.js';

import { BRIDGE_METHODS } from './bridge.js';

/**
 * Implémentation inerte du pont Minecraft (socle §11).
 *
 * Chaque méthode signale que la fonctionnalité n'est pas active, au lieu de
 * rendre une valeur vide. Un `null` silencieux se propagerait dans le code
 * appelant et produirait un affichage faux — un grade inexistant, un score à
 * zéro — que personne ne saurait distinguer d'une vraie donnée.
 *
 * L'erreur levée porte le gabarit `feature_unavailable` : le registre de
 * commandes répond au demandeur que la fonctionnalité n'est pas active, sans
 * planter, comme l'exige le §11.
 */

/** Capacité désactivée tant que `minecraft.enabled` vaut `false`. */
export const MINECRAFT_CAPABILITY = 'minecraft.bridge';

/**
 * Construit le pont.
 *
 * Retourne l'implémentation inerte tant qu'aucun pont réel n'existe. La
 * signature accepte déjà la configuration pour que le jour venu, seul ce
 * fichier change.
 *
 * @param {object} [options]
 * @param {boolean} [options.enabled] valeur de `minecraft.enabled`
 * @param {object} [options.logger]
 */
export function createMinecraftBridge({ enabled = false, logger = null } = {}) {
  if (enabled) {
    // Le pont n'existe pas : mieux vaut le dire au démarrage que laisser
    // croire qu'activer la clé suffit.
    logger?.warn('minecraft.enabled est vrai mais le pont est reporté hors v1', {
      capability: MINECRAFT_CAPABILITY,
    });
  }

  const unavailable = (method) => () => {
    throw new FeatureUnavailableError(MINECRAFT_CAPABILITY, {
      method,
      reason: 'pont Minecraft reporté hors v1',
    });
  };

  const bridge = { isEnabled: () => false };

  for (const method of BRIDGE_METHODS) bridge[method] = unavailable(method);

  return Object.freeze(bridge);
}

export { BRIDGE_METHODS } from './bridge.js';
