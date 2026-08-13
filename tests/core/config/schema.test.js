import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  CORE_SECTION_NAMES,
  CoreConfigSchema,
  unknownSections,
} from '../../../src/core/config/schema/core.schema.js';
import { EmbedsSchema, PALETTE_KEYS } from '../../../src/core/config/schema/embeds.schema.js';
import { loadYamlFiles } from '../../../src/core/config/loader.js';
import { MessagesSchema } from '../../../src/core/config/schema/messages.schema.js';

const ID = '123456789012345678';

const VALID_CONFIG = {
  bot: { guild_id: ID, timezone: 'Europe/Paris' },
  commands: { reload: { allowed_roles: [ID] } },
  database: { file: 'data/cubex.sqlite', busy_timeout_ms: 5000 },
  logging: { level: 'info', directory: 'logs', file_prefix: 'cubex', retention_days: 30 },
  purge: { hour: 4 },
  minecraft: { enabled: false },
};

const failure = (schema, value) => {
  const result = schema.safeParse(value);
  assert.equal(result.success, false, 'la valeur aurait dû être refusée');
  return result.error.issues[0];
};

const without = (section) => {
  const { [section]: _removed, ...rest } = VALID_CONFIG;
  return rest;
};

describe('config.yml', () => {
  test('accepte une configuration complète', () => {
    assert.equal(CoreConfigSchema.safeParse(VALID_CONFIG).success, true);
  });

  test('exige chacune des sections du noyau', () => {
    for (const section of CORE_SECTION_NAMES) {
      assert.equal(
        CoreConfigSchema.safeParse(without(section)).success,
        false,
        `la section ${section} devrait être obligatoire`,
      );
    }
  });

  test('tolère à la racine une section dont le module n\'est pas écrit', () => {
    const result = CoreConfigSchema.safeParse({
      ...VALID_CONFIG,
      tickets: { max_open_per_user: 2 },
    });

    assert.equal(result.success, true);
  });

  test('signale la section orpheline sans la faire échouer', () => {
    assert.deepEqual(unknownSections({ ...VALID_CONFIG, tickets: {} }), ['tickets']);
    assert.deepEqual(unknownSections(VALID_CONFIG), []);
  });

  test('une section mal orthographiée reste bloquante par la section manquante', () => {
    const { purge, ...rest } = VALID_CONFIG;
    const typo = { ...rest, purg: purge };

    // Le démarrage échoue sur `purge` manquante, l'avertissement nomme `purg`.
    assert.equal(CoreConfigSchema.safeParse(typo).success, false);
    assert.deepEqual(unknownSections(typo), ['purg']);
  });

  test('refuse une clé inconnue à l\'intérieur d\'une section', () => {
    const issue = failure(CoreConfigSchema, {
      ...VALID_CONFIG,
      bot: { ...VALID_CONFIG.bot, salon: ID },
    });

    assert.equal(issue.code, 'unrecognized_keys');
  });

  test('valide les commandes des modules sans les connaître', () => {
    const result = CoreConfigSchema.safeParse({
      ...VALID_CONFIG,
      commands: { reload: { allowed_roles: [ID] }, casier: { allowed_roles: 'public' } },
    });

    assert.equal(result.success, true);
    assert.equal(result.data.commands.casier.allowed_roles, 'public');
  });

  test('exige la commande reload et refuse une liste de rôles vide', () => {
    assert.equal(CoreConfigSchema.safeParse({ ...VALID_CONFIG, commands: {} }).success, false);

    const issue = failure(CoreConfigSchema, {
      ...VALID_CONFIG,
      commands: { reload: { allowed_roles: [] } },
    });
    assert.match(issue.message, /"public"/);
  });

  test('refuse un chemin absolu', () => {
    const issue = failure(CoreConfigSchema, {
      ...VALID_CONFIG,
      database: { ...VALID_CONFIG.database, file: 'C:\\cubex\\base.sqlite' },
    });

    assert.match(issue.message, /chemin relatif/);
  });

  test('refuse un fuseau horaire inconnu', () => {
    const issue = failure(CoreConfigSchema, {
      ...VALID_CONFIG,
      bot: { guild_id: ID, timezone: 'Europe/Pariss' },
    });

    assert.match(issue.message, /fuseau horaire/);
    assert.deepEqual(issue.path, ['bot', 'timezone']);
  });

  test('accepte minuit mais refuse 24 heures', () => {
    assert.equal(
      CoreConfigSchema.safeParse({ ...VALID_CONFIG, purge: { hour: 0 } }).success,
      true,
    );
    assert.equal(
      CoreConfigSchema.safeParse({ ...VALID_CONFIG, purge: { hour: 24 } }).success,
      false,
    );
  });

  test('refuse un préfixe de fichier de journal mal formé', () => {
    for (const file_prefix of ['Cubex', 'cubex_bot', '1cubex', '']) {
      assert.equal(
        CoreConfigSchema.safeParse({
          ...VALID_CONFIG,
          logging: { ...VALID_CONFIG.logging, file_prefix },
        }).success,
        false,
        `le préfixe ${file_prefix} aurait dû être refusé`,
      );
    }
  });

  test('refuse une rétention nulle', () => {
    assert.equal(
      CoreConfigSchema.safeParse({
        ...VALID_CONFIG,
        logging: { ...VALID_CONFIG.logging, retention_days: 0 },
      }).success,
      false,
    );
  });

  test('refuse un identifiant de serveur écrit sans guillemets', () => {
    const issue = failure(CoreConfigSchema, { ...VALID_CONFIG, bot: { guild_id: 123456789012345678 } });

    assert.match(issue.message, /sans guillemets/);
    assert.deepEqual(issue.path, ['bot', 'guild_id']);
  });
});

describe('messages.yml', () => {
  test('accepte un arbre de chaînes de profondeur libre', () => {
    const result = MessagesSchema.safeParse({
      commands: { denied: { title: 'Accès refusé', lines: ['une', 'deux'] } },
      simple: 'texte',
    });

    assert.equal(result.success, true);
  });

  test('n\'impose aucune clé', () => {
    assert.equal(MessagesSchema.safeParse({}).success, true);
  });

  test('refuse un réglage technique égaré', () => {
    for (const value of [{ retention_days: 30 }, { enabled: true }, { seuil: null }]) {
      const issue = failure(MessagesSchema, value);
      assert.match(issue.message, /aucun réglage technique/);
    }
  });
});

describe('embeds.yml', () => {
  const VALID_EMBEDS = {
    colors: { brand: '#F60321', success: '#57F287', error: '#E67E22', info: '#5865F2' },
    footer: { text: 'Cubex', timestamp: true },
    templates: { command_denied: { color: 'error', description_key: 'commands.denied.description' } },
  };

  test('accepte un fichier complet', () => {
    assert.equal(EmbedsSchema.safeParse(VALID_EMBEDS).success, true);
  });

  test('exige les quatre clés de palette', () => {
    for (const key of PALETTE_KEYS) {
      const { [key]: _removed, ...colors } = VALID_EMBEDS.colors;
      assert.equal(
        EmbedsSchema.safeParse({ ...VALID_EMBEDS, colors }).success,
        false,
        `la couleur ${key} devrait être obligatoire`,
      );
    }
  });

  test('refuse une cinquième couleur dans la palette', () => {
    const issue = failure(EmbedsSchema, {
      ...VALID_EMBEDS,
      colors: { ...VALID_EMBEDS.colors, warning: '#FFAA00' },
    });

    assert.equal(issue.code, 'unrecognized_keys');
  });

  test('refuse une couleur de palette qui n\'est pas hexadécimale', () => {
    const issue = failure(EmbedsSchema, {
      ...VALID_EMBEDS,
      colors: { ...VALID_EMBEDS.colors, brand: 'rouge' },
    });

    assert.match(issue.message, /hexadécimal/);
  });

  test('accepte un gabarit sans titre mais exige une description', () => {
    assert.equal(
      EmbedsSchema.safeParse({
        ...VALID_EMBEDS,
        templates: { sans_titre: { color: 'info', description_key: 'a.b' } },
      }).success,
      true,
    );
    assert.equal(
      EmbedsSchema.safeParse({
        ...VALID_EMBEDS,
        templates: { sans_description: { color: 'info', title_key: 'a.b' } },
      }).success,
      false,
    );
  });

  test('refuse un texte écrit en clair là où une clé est attendue', () => {
    const issue = failure(EmbedsSchema, {
      ...VALID_EMBEDS,
      templates: { direct: { color: 'info', description_key: 'Cette commande est réservée.' } },
    });

    assert.match(issue.message, /chemin pointé vers messages\.yml/);
  });
});

// Les fichiers livrés doivent satisfaire les schémas : sans cela, le premier
// démarrage échouerait sur la configuration fournie avec le dépôt.
describe('fichiers livrés dans config/', () => {
  const { files, errors } = loadYamlFiles();

  test('les trois fichiers sont lisibles', () => {
    assert.deepEqual(errors, []);
  });

  test('config.yml satisfait le schéma du noyau', () => {
    const result = CoreConfigSchema.safeParse(files.config);

    assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
    assert.deepEqual(unknownSections(files.config), []);
  });

  test('messages.yml satisfait le schéma', () => {
    const result = MessagesSchema.safeParse(files.messages);

    assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
  });

  test('embeds.yml satisfait le schéma', () => {
    const result = EmbedsSchema.safeParse(files.embeds);

    assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
  });

  test('chaque *_key des gabarits pointe vers un texte existant', () => {
    // Anticipe crossref.js : la vérification est faite ici sur les seuls
    // fichiers livrés, pour qu'ils ne partent pas déjà incohérents.
    const resolve = (key) =>
      key.split('.').reduce((node, part) => (node === undefined ? undefined : node[part]), files.messages);

    for (const [name, template] of Object.entries(files.embeds.templates)) {
      for (const field of ['title_key', 'description_key']) {
        const key = template[field];
        if (key === undefined) continue;

        assert.equal(typeof resolve(key), 'string', `${name}.${field} → ${key} introuvable`);
      }
    }
  });
});
