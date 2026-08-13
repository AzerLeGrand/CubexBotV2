import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { Configuration } from '../../../src/core/config/index.js';
import { ConfigValidationError } from '../../../src/core/config/errors.js';
import { ConfigStore, resolve } from '../../../src/core/config/store.js';
import { tempDir } from '../../helpers/fixtures.js';

const ID = '123456789012345678';
const AUTRE_ID = '987654321098765432';

const CONFIG = `
bot:
  guild_id: "${ID}"
commands:
  reload:
    allowed_roles: ["${ID}"]
database:
  file: "data/cubex.sqlite"
logging:
  level: "info"
  directory: "logs"
  retention_days: 30
purge:
  hour: 4
  timezone: "Europe/Paris"
minecraft:
  enabled: false
`;

const MESSAGES = `
commands:
  denied:
    title: "Accès refusé"
    description: "Réservé à l'équipe."
config:
  reloaded:
    description: "{count} fichiers relus."
  lignes:
    - "Première ligne."
    - "Seconde, avec {username}."
`;

const EMBEDS = `
colors:
  brand: "#F60321"
  success: "#57F287"
  error: "#E67E22"
  info: "#5865F2"
footer:
  text: "Cubex"
  timestamp: true
templates:
  command_denied:
    color: "error"
    title_key: "commands.denied.title"
    description_key: "commands.denied.description"
`;

const files = (overrides = {}) => ({
  'config.yml': CONFIG,
  'messages.yml': MESSAGES,
  'embeds.yml': EMBEDS,
  ...overrides,
});

/** Journal factice : retient les entrées au lieu de les écrire. */
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

describe('resolve', () => {
  const tree = {
    tickets: {
      categories: [
        { id: 'game', category_id: ID },
        { id: 'store', category_id: AUTRE_ID },
      ],
    },
  };

  test('résout un chemin pointé', () => {
    assert.equal(resolve({ a: { b: 'x' } }, 'a.b'), 'x');
  });

  test('adresse une entrée de collection par sa clé id', () => {
    assert.equal(resolve(tree, 'tickets.categories[game].category_id'), ID);
    assert.equal(resolve(tree, 'tickets.categories[store].category_id'), AUTRE_ID);
  });

  test('ne dépend pas de l\'ordre des entrées', () => {
    const réordonné = { tickets: { categories: [...tree.tickets.categories].reverse() } };

    assert.equal(resolve(réordonné, 'tickets.categories[game].category_id'), ID);
  });

  test('rend undefined sur un identifiant ou un chemin inconnu', () => {
    assert.equal(resolve(tree, 'tickets.categories[absent].category_id'), undefined);
    assert.equal(resolve(tree, 'tickets.absent.category_id'), undefined);
    assert.equal(resolve(null, 'a.b'), undefined);
  });
});

describe('ConfigStore', () => {
  test('remplace de façon atomique et prévient les abonnés', () => {
    const store = new ConfigStore();
    const vu = [];

    store.on('reload', (event) => vu.push(event));
    store.replace({ config: { a: 1 }, messages: {}, embeds: {} });
    store.replace({ config: { a: 2 }, messages: {}, embeds: {} }, { actor: 'Azer' });

    assert.equal(vu.length, 2);
    assert.equal(vu[1].actor, 'Azer');
    assert.equal(vu[1].previous.config.a, 1);
    assert.equal(vu[1].current.config.a, 2);
    assert.equal(store.get('a'), 2);
  });

  test('lève sur un chemin inconnu, sauf valeur de repli', () => {
    const store = new ConfigStore();
    store.replace({ config: { a: 1 }, messages: {}, embeds: {} });

    assert.throws(() => store.get('absent'), /chemin de configuration inconnu/);
    assert.equal(store.get('absent', 'repli'), 'repli');
    assert.equal(store.get('absent', undefined), undefined);
  });

  test('lève tant que rien n\'est chargé', () => {
    assert.throws(() => new ConfigStore().get('a'), /non chargée/);
  });
});

describe('Configuration — chargement', () => {
  test('charge les trois fichiers et expose les réglages', (t) => {
    const dir = tempDir(t, files());
    const config = new Configuration({ dir });

    config.load();

    assert.equal(config.loaded, true);
    assert.equal(config.get('bot.guild_id'), ID);
    assert.equal(config.get('purge.hour'), 4);
    assert.equal(config.colors.brand, '#F60321');
    assert.equal(config.footer.text, 'Cubex');
    assert.equal(config.template('command_denied').color, 'error');
  });

  test('refuse de démarrer sur une configuration invalide', (t) => {
    const dir = tempDir(t, files({ 'config.yml': CONFIG.replace(`"${ID}"`, ID) }));

    assert.throws(() => new Configuration({ dir }).load(), ConfigValidationError);
  });

  test('refuse de démarrer quand un fichier manque', (t) => {
    // Le point qui se perd facilement : validate() n'a rien à redire sur un
    // fichier absent, seul le chargeur le signale. Ne regarder que la seconde
    // liste ferait démarrer le bot sur un messages.yml disparu.
    const { 'messages.yml': _absent, ...reste } = files();
    const dir = tempDir(t, reste);

    try {
      new Configuration({ dir }).load();
      assert.fail('le chargement aurait dû être refusé');
    } catch (error) {
      assert.ok(error instanceof ConfigValidationError);
      assert.equal(error.errors.length, 1);
      assert.equal(error.errors[0].file, 'messages.yml');
      assert.match(error.errors[0].message, /introuvable/);
    }
  });

  test('journalise les sections orphelines une fois chargée', (t) => {
    const dir = tempDir(t, { ...files(), 'config.yml': `${CONFIG}\ntickets:\n  a: 1\n` });
    const logger = fakeLogger();
    const config = new Configuration({ dir, logger });

    const { warnings } = config.load();

    assert.equal(warnings.length, 1);
    assert.equal(logger.of('warn').length, 1);
    assert.match(logger.of('warn')[0].message, /section inconnue/);
  });
});

describe('Configuration — rechargement à chaud', () => {
  const withConfig = (t) => {
    const dir = tempDir(t, files());
    const logger = fakeLogger();
    const config = new Configuration({ dir, logger });

    config.load();

    return { dir, logger, config };
  };

  test('remplace la configuration et prévient les abonnés', (t) => {
    const { dir, config } = withConfig(t);
    const vu = [];

    config.on('reload', (event) => vu.push(event));
    writeFileSync(join(dir, 'config.yml'), CONFIG.replace('hour: 4', 'hour: 5'), 'utf8');

    const résultat = config.reload({ actor: 'Azer' });

    assert.equal(résultat.ok, true);
    assert.deepEqual(résultat.errors, []);
    assert.equal(config.get('purge.hour'), 5);
    assert.equal(vu[0].actor, 'Azer');
  });

  test('conserve l\'ancienne configuration et ne lève pas quand la nouvelle est invalide', (t) => {
    const { dir, config } = withConfig(t);

    writeFileSync(join(dir, 'config.yml'), CONFIG.replace(`"${ID}"`, ID), 'utf8');

    const résultat = config.reload({ actor: 'Azer' });

    assert.equal(résultat.ok, false);
    assert.ok(résultat.errors.length > 0);
    assert.match(résultat.errors[0].message, /sans guillemets/);

    // L'ancienne configuration est toujours là, le bot continue de tourner.
    assert.equal(config.get('bot.guild_id'), ID);
    assert.equal(config.get('purge.hour'), 4);
  });

  test('conserve l\'ancienne configuration quand un fichier disparaît', (t) => {
    const { dir, config } = withConfig(t);

    writeFileSync(join(dir, 'messages.yml'), '', 'utf8');

    const résultat = config.reload();

    assert.equal(résultat.ok, false);
    assert.equal(config.text('commands.denied.title'), 'Accès refusé');
  });

  test('n\'émet aucun événement sur un rechargement refusé', (t) => {
    const { dir, config } = withConfig(t);
    let émis = 0;

    config.on('reload', () => (émis += 1));
    writeFileSync(join(dir, 'config.yml'), CONFIG.replace(`"${ID}"`, ID), 'utf8');
    config.reload();

    assert.equal(émis, 0);
  });

  test('journalise le résultat avec son auteur', (t) => {
    const { dir, logger, config } = withConfig(t);

    config.reload({ actor: 'Azer' });
    assert.equal(logger.of('info').at(-1).context.actor, 'Azer');

    writeFileSync(join(dir, 'config.yml'), CONFIG.replace(`"${ID}"`, ID), 'utf8');
    config.reload({ actor: 'Azer' });

    const refus = logger.of('warn').at(-1);
    assert.match(refus.message, /refusé/);
    assert.equal(refus.context.actor, 'Azer');
    assert.ok(refus.context.count > 0);
  });
});

describe('Configuration — accesseur, jamais instantané', () => {
  test('get résout au moment de l\'usage, pas au chargement', (t) => {
    const dir = tempDir(t, files());
    const config = new Configuration({ dir });
    config.load();

    // Lecture différée : la fonction est écrite avant le rechargement.
    const heure = () => config.get('purge.hour');

    assert.equal(heure(), 4);

    writeFileSync(join(dir, 'config.yml'), CONFIG.replace('hour: 4', 'hour: 5'), 'utf8');
    config.reload();

    assert.equal(heure(), 5);
  });
});

describe('Configuration — textes et variables', () => {
  const withConfig = (t) => {
    const dir = tempDir(t, files());
    const logger = fakeLogger();
    const config = new Configuration({ dir, logger });
    config.load();

    return { logger, config };
  };

  test('rend un texte et substitue ses variables', (t) => {
    const { config } = withConfig(t);

    assert.equal(config.text('commands.denied.title'), 'Accès refusé');
    assert.equal(config.text('config.reloaded.description', { count: 3 }), '3 fichiers relus.');
  });

  test('rend une liste de lignes', (t) => {
    const { config } = withConfig(t);

    assert.equal(
      config.text('config.lignes', { username: 'Azer' }),
      'Première ligne.\nSeconde, avec Azer.',
    );
  });

  test('journalise les variables non fournies — le contrat du moteur est écouté', (t) => {
    const { logger, config } = withConfig(t);

    const texte = config.text('config.reloaded.description');

    assert.equal(texte, '{count} fichiers relus.');
    const entrée = logger.of('error').at(-1);
    assert.match(entrée.message, /variables non fournies/);
    assert.deepEqual(entrée.context.missing, ['count']);
    assert.equal(entrée.context.key, 'config.reloaded.description');
  });

  test('rend une clé absente en clair et la journalise', (t) => {
    const { logger, config } = withConfig(t);

    assert.equal(config.text('commands.absent'), 'commands.absent');
    assert.match(logger.of('error').at(-1).message, /texte absent/);
  });
});

describe('Configuration — injection du logger', () => {
  test('rejoue ce qui a été dit avant l\'injection', (t) => {
    // Le premier chargement précède la création du logger : son niveau vient
    // de config.yml. Sans tampon, l'avertissement serait perdu.
    const dir = tempDir(t, { ...files(), 'config.yml': `${CONFIG}\ntickets:\n  a: 1\n` });
    const config = new Configuration({ dir });

    config.load();

    const logger = fakeLogger();
    config.setLogger(logger);

    assert.equal(logger.of('warn').length, 1);
    assert.match(logger.of('warn')[0].message, /section inconnue/);
  });

  test('passe en direct une fois injecté', (t) => {
    const dir = tempDir(t, files());
    const config = new Configuration({ dir });
    config.load();

    const logger = fakeLogger();
    config.setLogger(logger);
    const avant = logger.entries.length;

    config.text('commands.absent');

    assert.equal(logger.entries.length, avant + 1);
  });
});
