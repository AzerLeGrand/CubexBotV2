import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CapabilityRegistry } from '../../../src/core/config/capabilities.js';
import { verifyDiscordRefs } from '../../../src/core/config/discord-refs.js';
import { loadYamlFiles } from '../../../src/core/config/loader.js';
import { capabilities as declared, name } from '../../../src/modules/verification/index.js';

/**
 * Effets du §9 de la spec, vérifiés sur la configuration réellement livrée.
 *
 * Une référence critique introuvable désactive le module entier ; une référence
 * simple ne désactive que sa capacité. Un salon d'alerte supprimé ne doit pas
 * empêcher les membres d'entrer sur le serveur — c'est toute la raison d'être de
 * la distinction.
 */

const fakeLogger = () => {
  const entries = [];
  const record = (level) => (message, context) => entries.push({ level, message, context });

  return {
    entries,
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    of: (level) => entries.filter((entry) => entry.level === level),
  };
};

/**
 * Serveur factice. `missing` liste les identifiants à déclarer introuvables ;
 * tout le reste résout.
 */
const fakeGuild = (missing = []) => {
  const absent = new Set(missing);
  const fetch = (id) => (absent.has(id) ? Promise.resolve(null) : Promise.resolve({ id, type: 0 }));

  return { roles: { fetch }, channels: { fetch } };
};

/** Déclarations telles que src/index.js les enrichit du module propriétaire. */
const declarations = declared.map((declaration) => ({ ...declaration, module: name }));

const { files } = loadYamlFiles();

const verify = async (missing = []) => {
  const capabilities = new CapabilityRegistry();
  const logger = fakeLogger();

  const result = await verifyDiscordRefs({
    guild: fakeGuild(missing),
    config: files.config,
    declarations,
    capabilities,
    logger,
  });

  return { capabilities, logger, result };
};

const ids = files.config.verification;

describe('références toutes valides', () => {
  test('aucune capacité désactivée, aucun avertissement', async () => {
    const { capabilities, logger, result } = await verify();

    assert.deepEqual(result.disabled, []);
    assert.deepEqual(result.disabledModules, []);
    assert.deepEqual(result.missingPaths, [], 'aucun chemin déclaré ne manque dans config.yml');
    assert.equal(logger.of('warn').length, 0, 'le §5.5 exige le silence quand tout résout');
    assert.equal(capabilities.isModuleEnabled('verification'), true);
  });

  test('chaque chemin déclaré résout dans la configuration livrée', async () => {
    // Attrape le décalage entre le manifeste et config.yml après un renommage
    // de clé : le noyau le signale en error, jamais en silence.
    const { logger, result } = await verify();

    // Sept vérifications pour cinq capacités et six identifiants distincts : le
    // salon d'alerte est déclaré par les deux alertes, donc contrôlé deux fois.
    assert.equal(result.checked, 7);
    assert.equal(logger.of('error').length, 0);
  });
});

describe('référence critique introuvable', () => {
  for (const [nom, path] of [
    ['le salon de vérification', 'channel_id'],
    ['le rôle de membre', 'member_role_id'],
  ]) {
    test(`${nom} désactive le module entier`, async () => {
      const { capabilities } = await verify([ids[path]]);

      assert.equal(capabilities.isModuleEnabled('verification'), false);
      assert.match(capabilities.moduleReason('verification'), new RegExp(path));
    });
  }

  test('le bot ne s\'arrête pas pour autant', async () => {
    // Socle §5.5 : une référence introuvable désactive, elle n'arrête jamais.
    const { logger } = await verify([ids.channel_id]);

    assert.equal(logger.of('warn').length > 0, true);
    assert.equal(logger.of('error').length, 0, 'un salon supprimé n\'est pas un défaut du code');
  });
});

describe('référence simple introuvable', () => {
  test('le salon d\'alerte fait taire les deux alertes, sans plus', async () => {
    const { capabilities } = await verify([ids.alert.channel_id]);

    assert.equal(capabilities.isActive('verification.alert.exhausted'), false);
    assert.equal(capabilities.isActive('verification.alert.failure'), false);

    // L'essentiel : les membres continuent d'entrer sur le serveur.
    assert.equal(capabilities.isModuleEnabled('verification'), true);
    assert.equal(capabilities.isActive('verification.channel'), true);
    assert.equal(capabilities.isActive('verification.role'), true);
    assert.equal(capabilities.isActive('verification.log'), true);
  });

  test('un rôle d\'alerte perdu ne fait taire que son alerte', async () => {
    const { capabilities } = await verify([ids.alert.exhausted_role_id]);

    assert.equal(capabilities.isActive('verification.alert.exhausted'), false);
    assert.equal(capabilities.isActive('verification.alert.failure'), true, 'l\'autre est intacte');
    assert.equal(capabilities.isModuleEnabled('verification'), true);
  });

  test('le salon de journalisation perdu laisse la vérification entière', async () => {
    const { capabilities } = await verify([ids.log.channel_id]);

    // La base continue d'enregistrer : un salon supprimé ne doit pas faire
    // perdre l'historique.
    assert.equal(capabilities.isActive('verification.log'), false);
    assert.equal(capabilities.isModuleEnabled('verification'), true);
  });
});

describe('forme des déclarations', () => {
  test('deux capacités critiques, trois simples', () => {
    const critical = declared.filter((declaration) => declaration.critical === true);

    assert.deepEqual(
      critical.map((declaration) => declaration.id),
      ['verification.channel', 'verification.role'],
    );
    assert.equal(declared.length - critical.length, 3);
  });

  test('les deux alertes partagent le salon et se distinguent par leur rôle', () => {
    // C'est ce partage qui produit la colonne « effet si introuvable » du §9
    // sans une ligne de code : salon perdu, les deux tombent ; rôle perdu, une
    // seule.
    const alerts = declared.filter((declaration) => declaration.id.startsWith('verification.alert.'));

    for (const alert of alerts) {
      assert.equal(alert.refs[0].path, 'verification.alert.channel_id');
      assert.equal(alert.refs[0].kind, 'channel');
      assert.equal(alert.refs[1].kind, 'role');
    }

    assert.equal(new Set(alerts.map((alert) => alert.refs[1].path)).size, 2);
  });

  test('le module est complet : il déclare tout ce que le contrat prévoit', async () => {
    const module = await import('../../../src/modules/verification/index.js');

    // Le contrat entier du socle, tel que CLAUDE.md le décrit. La phase 1 est
    // le premier module à en remplir toutes les cases.
    for (const field of [
      'name',
      'migrations',
      'retention',
      'erasure',
      'capabilities',
      'init',
      'ready',
      'events',
      'components',
      'commands',
    ]) {
      assert.notEqual(module[field], undefined, `${field} est déclaré`);
    }

    assert.equal(module.components.length, 3, 'start, open et submit');
    assert.equal(module.events.length, 1, 'la seule republication du message d\'accueil');
    assert.equal(module.commands.length, 1, 'le seul déblocage');
  });
});
