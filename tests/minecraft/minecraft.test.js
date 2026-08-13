import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { FeatureUnavailableError } from '../../src/core/errors/index.js';
import { BRIDGE_METHODS, createMinecraftBridge, MINECRAFT_CAPABILITY } from '../../src/minecraft/index.js';

const fakeLogger = () => {
  const entries = [];

  return {
    entries,
    error: () => {},
    warn: (message, context) => entries.push({ message, context }),
    info: () => {},
    debug: () => {},
  };
};

describe('pont inerte', () => {
  test('se déclare inactif', () => {
    assert.equal(createMinecraftBridge().isEnabled(), false);
  });

  test('fournit toutes les méthodes de l\'interface', () => {
    const bridge = createMinecraftBridge();

    for (const method of BRIDGE_METHODS) {
      assert.equal(typeof bridge[method], 'function', `méthode ${method} absente`);
    }
  });

  test('chaque méthode signale l\'indisponibilité au lieu de rendre une valeur vide', () => {
    // Un null silencieux se propagerait et produirait un affichage faux — un
    // grade inexistant, un score à zéro — indistinguable d'une vraie donnée.
    const bridge = createMinecraftBridge();

    for (const method of BRIDGE_METHODS) {
      assert.throws(() => bridge[method]('argument'), FeatureUnavailableError, `méthode ${method}`);
    }
  });

  test('l\'erreur porte le gabarit de réponse et nomme la méthode', () => {
    const bridge = createMinecraftBridge();

    try {
      bridge.getRank('uuid');
      assert.fail('aurait dû lever');
    } catch (error) {
      // Le registre de commandes répond « fonctionnalité indisponible » sans
      // planter (socle §11).
      assert.equal(error.template, 'feature_unavailable');
      assert.equal(error.expected, true);
      assert.equal(error.toLog().capability, MINECRAFT_CAPABILITY);
      assert.equal(error.toLog().method, 'getRank');
    }
  });

  test('reste inerte même si la configuration l\'active, en le signalant', () => {
    // Activer la clé ne suffit pas : mieux vaut le dire au démarrage.
    const logger = fakeLogger();
    const bridge = createMinecraftBridge({ enabled: true, logger });

    assert.equal(bridge.isEnabled(), false);
    assert.match(logger.entries[0].message, /reporté hors v1/);
  });

  test('ne se laisse pas remplacer méthode par méthode', () => {
    const bridge = createMinecraftBridge();

    assert.throws(() => {
      bridge.getRank = () => 'admin';
    }, TypeError);
  });
});
