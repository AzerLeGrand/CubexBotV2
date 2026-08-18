import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CapabilityRegistry } from '../../../src/core/config/capabilities.js';
import { Configuration } from '../../../src/core/config/index.js';
import { buildConfigSchema } from '../../../src/core/config/schema/core.schema.js';
import {
  logChannelCapability,
  LOG_CHANNELS,
  LOG_EVENTS,
} from '../../../src/modules/logs/constants.js';
import { capabilities as declared, name } from '../../../src/modules/logs/index.js';
import { schema } from '../../../src/modules/logs/manifest.js';
import { createRouter } from '../../../src/modules/logs/router.js';

/**
 * Aiguillage d'un événement vers son salon.
 *
 * Les cas nominaux tournent sur la configuration RÉELLEMENT LIVRÉE : un
 * aiguillage validé contre une configuration inventée ne prouverait pas que le
 * fichier du dépôt fonctionne. Les cas de dégradation passent par une
 * configuration factice, seule façon de simuler un `/reload`.
 */

/**
 * Configuration du dépôt, chargée et validée comme au démarrage.
 *
 * Le fragment est importé directement plutôt que découvert par `loadManifests()`
 * : celui-ci lit `GatewayIntentBits`, donc importe discord.js, et rien de ce lot
 * ne doit dépendre de la bibliothèque — pas même transitivement, pas même dans
 * un test. Les sections des autres modules restent validées par la racine souple
 * du schéma composé.
 */
const realConfig = new Configuration({ configSchema: buildConfigSchema({ logs: schema }) });

realConfig.load();

/** Registre où toutes les capacités du module sont déclarées et actives. */
const activeRegistry = () => {
  const capabilities = new CapabilityRegistry();

  for (const declaration of declared) capabilities.declare(declaration.id, { module: name });

  return capabilities;
};

/** Configuration mutable, pour prouver l'absence de cache. */
const mutableConfig = (values) => ({
  values,
  get(path, ...fallback) {
    if (Object.hasOwn(this.values, path)) return this.values[path];
    if (fallback.length > 0) return fallback[0];

    throw new Error(`chemin de configuration inconnu : ${path}`);
  },
});

describe('resolve sur la configuration livrée', () => {
  test('rend un salon existant pour chacun des 33 types', () => {
    const router = createRouter({ config: realConfig, capabilities: activeRegistry() });

    for (const type of LOG_EVENTS) {
      const routing = router.resolve(type);

      assert.ok(LOG_CHANNELS.includes(routing.channelKey), `${type} : ${routing.channelKey}`);
      assert.equal(
        routing.channelId,
        realConfig.get(`logs.channels.${routing.channelKey}`),
        type,
      );
      assert.equal(routing.deliverable, true, type);
      assert.equal(routing.reason, null, type);
    }
  });

  test('le salon rendu est bien celui que config.yml désigne', () => {
    const router = createRouter({ config: realConfig, capabilities: activeRegistry() });

    for (const type of LOG_EVENTS) {
      assert.equal(router.resolve(type).channelKey, realConfig.get(`logs.events.${type}.channel`));
    }
  });

  test('les 33 types sont couverts, aucun oublié', () => {
    // Garde-fou : sans lui, une boucle sur une liste vide passerait pour un
    // succès.
    assert.equal(LOG_EVENTS.length, 33);
  });
});

describe('capacité désactivée', () => {
  const withDisabled = (channelKey, reason) => {
    const capabilities = activeRegistry();

    capabilities.disable(logChannelCapability(channelKey), reason);

    return createRouter({ config: realConfig, capabilities });
  };

  test('deliverable est faux et reason porte le motif du registre', () => {
    const motif = 'salon introuvable (logs.channels.moderation)';
    const router = withDisabled('moderation', motif);

    const routing = router.resolve('member_ban');

    assert.equal(routing.deliverable, false);
    assert.equal(routing.reason, motif);
  });

  test('l\'identifiant du salon reste rendu malgré tout', () => {
    // `resolve` DÉCRIT, elle n'empêche rien : l'appelant a déjà écrit en base
    // quand il l'interroge, et le lot 4 doit pouvoir dire lequel des salons est
    // muet.
    const routing = withDisabled('moderation', 'motif').resolve('member_ban');

    assert.equal(routing.channelKey, 'moderation');
    assert.equal(routing.channelId, realConfig.get('logs.channels.moderation'));
  });

  test('ne fait taire que les événements de ce salon', () => {
    const router = withDisabled('voice', 'salon vocal supprimé');

    assert.equal(router.resolve('voice_join').deliverable, false);
    assert.equal(router.resolve('member_ban').deliverable, true);
    assert.equal(router.resolve('message_delete').deliverable, true);
  });

  test('un module désactivé en bloc éteint toutes les capacités', () => {
    const capabilities = activeRegistry();

    capabilities.disableModule(name, 'module éteint');

    const router = createRouter({ config: realConfig, capabilities });

    for (const type of ['member_ban', 'voice_join', 'guild_update']) {
      const routing = router.resolve(type);

      assert.equal(routing.deliverable, false, type);
      assert.equal(routing.reason, 'module éteint', type);
    }
  });

  test('l\'identifiant de capacité interrogé est celui que le module déclare', () => {
    // Le mode de défaillance que ce test ferme : une capacité jamais déclarée
    // est considérée ACTIVE par le registre. Un décalage entre la déclaration et
    // la lecture produirait donc un deliverable vrai sur un salon supprimé.
    assert.deepEqual(
      declared.map((declaration) => declaration.id),
      LOG_CHANNELS.map((key) => logChannelCapability(key)),
    );
  });
});

describe('resolve ne lève jamais', () => {
  const config = mutableConfig({});

  test('un type sans salon configuré rend un verdict, pas une exception', () => {
    const router = createRouter({ config, capabilities: activeRegistry() });

    let routing;

    assert.doesNotThrow(() => {
      routing = router.resolve('type_inexistant');
    });

    assert.deepEqual(routing, {
      channelKey: null,
      channelId: null,
      deliverable: false,
      reason: "aucun salon configuré pour l'événement type_inexistant",
    });
  });

  test('une clé de salon qui ne résout pas rend un verdict', () => {
    // Atteignable seulement entre un /reload et la validation qui le suit, mais
    // un undefined propagé jusqu'à un appel Discord au lot 4 coûterait plus cher
    // que ces trois lignes.
    const router = createRouter({
      config: mutableConfig({ 'logs.events.member_ban.channel': 'fantome' }),
      capabilities: activeRegistry(),
    });

    const routing = router.resolve('member_ban');

    assert.equal(routing.channelKey, 'fantome');
    assert.equal(routing.channelId, null);
    assert.equal(routing.deliverable, false);
    assert.match(routing.reason, /logs\.channels\.fantome/);
  });
});

describe('isEnabled', () => {
  test('suit la configuration livrée', () => {
    const router = createRouter({ config: realConfig, capabilities: activeRegistry() });

    for (const type of LOG_EVENTS) {
      assert.equal(router.isEnabled(type), realConfig.get(`logs.events.${type}.enabled`), type);
    }
  });

  test('rend faux quand l\'événement est coupé', () => {
    const router = createRouter({
      config: mutableConfig({ 'logs.events.member_ban.enabled': false }),
      capabilities: activeRegistry(),
    });

    assert.equal(router.isEnabled('member_ban'), false);
  });

  test('lève sur un type inconnu, plutôt que de le taire', () => {
    // Se rabattre sur `false` ferait disparaître un écouteur entier en silence.
    const router = createRouter({ config: mutableConfig({}), capabilities: activeRegistry() });

    assert.throws(() => router.isEnabled('messsage_delete'), /chemin de configuration inconnu/);
  });
});

describe('aucun cache : un /reload est pris en compte', () => {
  test('une bascule d\'activation change le verdict entre deux appels', () => {
    const config = mutableConfig({ 'logs.events.member_ban.enabled': true });
    const router = createRouter({ config, capabilities: activeRegistry() });

    assert.equal(router.isEnabled('member_ban'), true);

    config.values['logs.events.member_ban.enabled'] = false;

    assert.equal(router.isEnabled('member_ban'), false, 'la valeur avait été figée au démarrage');
  });

  test('un changement de salon change l\'aiguillage entre deux appels', () => {
    const config = mutableConfig({
      'logs.events.member_ban.channel': 'moderation',
      'logs.channels.moderation': '111111111111111111',
      'logs.channels.server': '333333333333333333',
    });

    const router = createRouter({ config, capabilities: activeRegistry() });

    assert.equal(router.resolve('member_ban').channelId, '111111111111111111');

    config.values['logs.events.member_ban.channel'] = 'server';

    const routing = router.resolve('member_ban');

    assert.equal(routing.channelKey, 'server');
    assert.equal(routing.channelId, '333333333333333333');
  });

  test('un identifiant de salon corrigé est relu sans redémarrage', () => {
    const config = mutableConfig({
      'logs.events.voice_join.channel': 'voice',
      'logs.channels.voice': '444444444444444444',
    });

    const router = createRouter({ config, capabilities: activeRegistry() });

    assert.equal(router.resolve('voice_join').channelId, '444444444444444444');

    config.values['logs.channels.voice'] = '555555555555555555';

    assert.equal(router.resolve('voice_join').channelId, '555555555555555555');
  });
});
