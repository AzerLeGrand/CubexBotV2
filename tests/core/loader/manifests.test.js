import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { GatewayIntentBits } from 'discord.js';
import { z } from 'zod';

import { Configuration } from '../../../src/core/config/index.js';
import { ConfigValidationError } from '../../../src/core/config/errors.js';
import { buildConfigSchema, CORE_SECTION_NAMES } from '../../../src/core/config/schema/core.schema.js';
import { snowflake } from '../../../src/core/config/schema/primitives.js';
import { loadManifests, ManifestError, resolveIntents } from '../../../src/core/loader/manifests.js';
import { fromRoot } from '../../../src/utils/paths.js';
import { tempDir } from '../../helpers/fixtures.js';

const ID = '123456789012345678';

/**
 * Dossier de modules réel : le balayage importe vraiment les manifestes, un
 * faux ne prouverait rien de ce qui compte ici.
 *
 * Créé sous la racine du projet et non dans le dossier temporaire du système :
 * un manifeste écrit `import { z } from 'zod'`, et ce spécifieur nu ne se
 * résout que par remontée vers `node_modules/`. Depuis /tmp, il échoue en
 * ERR_MODULE_NOT_FOUND — pour une raison sans rapport avec ce qu'on vérifie.
 */
const sandbox = (t) => {
  const parent = fromRoot('tests', '.tmp');
  mkdirSync(parent, { recursive: true });

  const root = mkdtempSync(join(parent, 'modules-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  /** Écrit un module : son index.js, et son manifest.js s'il en a un. */
  const write = (name, { manifest = null, entry = true } = {}) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });

    if (entry) writeFileSync(join(dir, 'index.js'), `export const name = '${name}';\n`, 'utf8');
    if (manifest !== null) writeFileSync(join(dir, 'manifest.js'), manifest, 'utf8');

    return dir;
  };

  return { root, write };
};

/** Manifeste déclarant un fragment à deux clés, dont un identifiant Discord. */
const FRAGMENT = `import { z } from 'zod';

export const schema = z.strictObject({
  channel_id: z.string().regex(/^\\d{17,20}$/),
  attempts: z.int().positive(),
});
`;

/** Les six sections du noyau, seules — sans celle du module. */
const CORE_YAML = `
bot:
  guild_id: "${ID}"
  timezone: "Europe/Paris"
commands:
  reload:
    allowed_roles: ["${ID}"]
database:
  file: "data/cubex.sqlite"
  busy_timeout_ms: 5000
logging:
  level: "info"
  directory: "logs"
  file_prefix: "cubex"
  retention_days: 30
purge:
  hour: 4
minecraft:
  enabled: false
`;

const VERIFICATION_YAML = `verification:\n  channel_id: "${ID}"\n  attempts: 3\n`;

/** Les deux autres fichiers, réduits à ce que leurs schémas exigent. */
const YAML = {
  'messages.yml': 'commands:\n  denied:\n    title: "Accès refusé"\n',
  'embeds.yml':
    'colors:\n  brand: "#F60321"\n  success: "#57F287"\n  error: "#E67E22"\n  info: "#5865F2"\n' +
    'footer:\n  text: "Cubex"\n  timestamp: true\ntemplates: {}\n',
};

const rejette = (t, name, manifest, motif) => {
  const { root, write } = sandbox(t);
  write(name, { manifest });

  return assert.rejects(() => loadManifests({ directory: root }), motif);
};

describe('loadManifests', () => {
  test('rend un balayage vide quand aucun module n\'existe', async () => {
    const { modules, fragments, intents } = await loadManifests({
      directory: fromRoot('tests', '.tmp', 'absent-xyz'),
    });

    assert.deepEqual(modules, []);
    assert.deepEqual(fragments, {});
    assert.deepEqual(intents, []);
  });

  test('un module sans manifeste est accepté et ne déclare rien', async (t) => {
    const { root, write } = sandbox(t);
    write('tickets');

    const { modules, fragments, intents } = await loadManifests({ directory: root });

    assert.deepEqual(modules, ['tickets']);
    assert.deepEqual(fragments, {}, 'aucun fragment');
    assert.deepEqual(intents, [], 'aucun intent');
  });

  test('collecte le fragment et les intents déclarés', async (t) => {
    const { root, write } = sandbox(t);
    write('verification', {
      manifest: `${FRAGMENT}\nexport const intents = ['GuildMembers', 'GuildMessages'];\n`,
    });

    const { modules, fragments, intents } = await loadManifests({ directory: root });

    assert.deepEqual(modules, ['verification']);
    assert.deepEqual(Object.keys(fragments), ['verification'], 'la section porte le nom du dossier');
    assert.deepEqual(intents, ['GuildMembers', 'GuildMessages']);
  });

  test('les deux exports sont facultatifs indépendamment l\'un de l\'autre', async (t) => {
    const { root, write } = sandbox(t);
    write('intents-seuls', { manifest: `export const intents = ['GuildMessages'];\n` });
    write('schema-seul', { manifest: FRAGMENT });

    const { fragments, intents } = await loadManifests({ directory: root });

    assert.deepEqual(Object.keys(fragments), ['schema-seul']);
    assert.deepEqual(intents, ['GuildMessages']);
  });

  test('voit exactement la même liste que loadModules : un dossier sans index.js est refusé', async (t) => {
    const { root, write } = sandbox(t);
    write('orphelin', { entry: false, manifest: FRAGMENT });

    // Deux balayages divergents laisseraient valider la section d'un module non
    // chargé, ou charger un module dont la section ne l'est pas.
    await assert.rejects(() => loadManifests({ directory: root }), /ne contient pas de index\.js/);
  });
});

describe('un manifeste cassé arrête le démarrage', () => {
  test('erreur de syntaxe', async (t) => {
    // Jamais ignoré : l'ignorer retirerait la section de la validation, en
    // silence — et une section non validée est ce qui a tué le bot précédent.
    await rejette(t, 'verification', 'export const schema = ;;;', ManifestError);
  });

  test('import introuvable, en nommant le module', async (t) => {
    await rejette(
      t,
      'verification',
      `import './inexistant.js';\nexport const schema = {};`,
      /manifeste du module « verification » non importable/,
    );
  });

  test('exception levée au chargement', async (t) => {
    await rejette(t, 'verification', `throw new Error('boum');`, /boum/);
  });

  test('« schema » qui n\'est pas un schéma zod', async (t) => {
    await rejette(
      t,
      'verification',
      'export const schema = { channel_id: "string" };',
      /« schema » doit être un schéma zod/,
    );
  });

  test('« intents » qui n\'est pas un tableau', async (t) => {
    await rejette(
      t,
      'verification',
      `export const intents = 'GuildMembers';`,
      /« intents » doit être un tableau/,
    );
  });

  test('fragment dont le nom heurte une section du noyau', async (t) => {
    // Un module ne redéfinit pas le noyau : le fragment écraserait sa section
    // sans que rien ne le signale.
    await rejette(t, 'purge', FRAGMENT, /module « purge » .+ section du noyau/s);
  });

  test('intent inconnu, en nommant le module et la valeur', async (t) => {
    await rejette(
      t,
      'verification',
      `export const intents = ['GuildMember'];`,
      /module « verification » .+ intent Discord inconnu : "GuildMember"/s,
    );
  });

  test('intent donné en valeur numérique', async (t) => {
    // Un bit brut priverait le message d'erreur du seul élément qui permette de
    // retrouver la ligne fautive.
    await rejette(t, 'verification', 'export const intents = [2];', /intent Discord inconnu : 2/);
  });

  test('intent donné en clé inverse de l\'énumération', async (t) => {
    // GatewayIntentBits[1] vaut 'Guilds' : tester la seule présence de la clé
    // accepterait "1" comme nom d'intent.
    await rejette(t, 'verification', `export const intents = ['1'];`, /intent Discord inconnu/);
  });
});

describe('resolveIntents', () => {
  test('dédoublonne l\'union et conserve Guilds', () => {
    const { names } = resolveIntents(['Guilds', 'GuildMembers', 'GuildMessages', 'GuildMembers']);

    assert.deepEqual(names, ['Guilds', 'GuildMembers', 'GuildMessages']);
  });

  test('résout les noms en bits de la passerelle', () => {
    const { bits } = resolveIntents(['Guilds', 'GuildMessages']);

    assert.deepEqual(bits, [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]);
    assert.ok(bits.every((bit) => typeof bit === 'number'));
  });

  test('signale les seuls intents privilégiés demandés', () => {
    assert.deepEqual(resolveIntents(['Guilds', 'GuildMessages']).privileged, []);
    assert.deepEqual(
      resolveIntents(['Guilds', 'GuildMembers', 'MessageContent']).privileged,
      ['GuildMembers', 'MessageContent'],
    );
  });

  test('refuse un nom inconnu, y compris hors manifeste', () => {
    assert.throws(() => resolveIntents(['Guildss']), ManifestError);
    assert.throws(() => resolveIntents(['Guilds', undefined]), /intent Discord inconnu/);
  });
});

describe('un fragment est réellement validé', () => {
  const fragment = z.strictObject({ channel_id: snowflake(), attempts: z.int().positive() });
  const schema = buildConfigSchema({ verification: fragment });

  const CONFIG = {
    bot: { guild_id: ID, timezone: 'Europe/Paris' },
    commands: { reload: { allowed_roles: [ID] } },
    database: { file: 'data/cubex.sqlite', busy_timeout_ms: 5000 },
    logging: { level: 'info', directory: 'logs', file_prefix: 'cubex', retention_days: 30 },
    purge: { hour: 4 },
    minecraft: { enabled: false },
    verification: { channel_id: ID, attempts: 3 },
  };

  const issues = (config) => {
    const result = schema.safeParse(config);
    assert.equal(result.success, false, 'la configuration aurait dû être refusée');

    return result.error.issues;
  };

  test('accepte une section conforme', () => {
    const result = schema.safeParse(CONFIG);

    assert.equal(result.success, true, JSON.stringify(result.error?.issues));
    assert.equal(result.data.verification.channel_id, ID);
  });

  test('n\'écrase aucune section du noyau', () => {
    for (const section of CORE_SECTION_NAMES) {
      const { [section]: _absente, ...reste } = CONFIG;
      assert.equal(schema.safeParse(reste).success, false, `la section ${section} reste obligatoire`);
    }
  });

  test('une clé manquante devient une erreur bloquante, avec son chemin complet', () => {
    const [issue] = issues({ ...CONFIG, verification: { channel_id: ID } });

    assert.deepEqual(issue.path, ['verification', 'attempts']);
  });

  test('un identifiant Discord fourni en nombre est refusé', () => {
    // La panne qui a arrêté la version précédente du bot, à l'endroit précis où
    // elle passerait sans fragment validé.
    const [issue] = issues({ ...CONFIG, verification: { channel_id: 123456789012345678, attempts: 3 } });

    assert.deepEqual(issue.path, ['verification', 'channel_id']);
    assert.match(issue.message, /sans guillemets/);
  });

  test('une clé inconnue dans la section est refusée', () => {
    const [issue] = issues({ ...CONFIG, verification: { ...CONFIG.verification, oups: 1 } });

    assert.equal(issue.code, 'unrecognized_keys');
    assert.deepEqual(issue.keys, ['oups']);
  });

  test('la racine reste souple : une section sans module attend dans le fichier', () => {
    assert.equal(schema.safeParse({ ...CONFIG, tickets: { max_open_per_user: 2 } }).success, true);
  });

  test('section absente : refus portant la liste des clés manquantes', () => {
    const { verification: _absente, ...sans } = CONFIG;

    assert.deepEqual(
      issues(sans).map((issue) => issue.path.join('.')),
      ['verification.channel_id', 'verification.attempts'],
    );
  });

  test('section présente mais vide : même diagnostic', () => {
    // js-yaml rend null pour `verification:` sans corps — l'en-tête écrit puis
    // l'interruption. C'est la même erreur d'édition que la section absente.
    for (const vide of [null, {}]) {
      assert.deepEqual(
        issues({ ...CONFIG, verification: vide }).map((issue) => issue.path.join('.')),
        ['verification.channel_id', 'verification.attempts'],
        `section ${JSON.stringify(vide)}`,
      );
    }
  });

  test('une section renseignée d\'un scalaire reste une erreur de type', () => {
    const [issue] = issues({ ...CONFIG, verification: 4 });

    assert.deepEqual(issue.path, ['verification']);
    assert.equal(issue.code, 'invalid_type');
  });
});

describe('un module impose sa section', () => {
  /** Chaîne complète : manifeste sur disque, schéma composé, configuration. */
  const configure = async (t, { config = CORE_YAML } = {}) => {
    const { root, write } = sandbox(t);
    write('verification', { manifest: FRAGMENT });

    const { fragments } = await loadManifests({ directory: root });
    const dir = tempDir(t, { ...YAML, 'config.yml': config });

    return new Configuration({
      dir,
      configSchema: buildConfigSchema(fragments),
      knownSections: [...CORE_SECTION_NAMES, ...Object.keys(fragments)],
    });
  };

  test('module présent, section absente de config.yml : démarrage refusé', async (t) => {
    const config = await configure(t);

    try {
      config.load();
      assert.fail('le chargement aurait dû être refusé');
    } catch (error) {
      assert.ok(error instanceof ConfigValidationError);
      assert.deepEqual(
        error.errors.map((anomalie) => anomalie.key),
        ['verification.channel_id', 'verification.attempts'],
      );
      assert.equal(error.errors[0].file, 'config.yml');
    }
  });

  test('la section du module ne passe plus pour orpheline', async (t) => {
    const config = await configure(t, { config: `${CORE_YAML}${VERIFICATION_YAML}` });

    const { warnings } = config.load();

    assert.deepEqual(warnings, [], 'la section est déclarée, plus rien à signaler');
    assert.equal(config.get('verification.attempts'), 3);
  });
});

describe('le fragment survit au rechargement à chaud', () => {
  const CONFIG = `${CORE_YAML}${VERIFICATION_YAML}`;

  const withConfig = (t) => {
    const dir = tempDir(t, { ...YAML, 'config.yml': CONFIG });

    const config = new Configuration({
      dir,
      configSchema: buildConfigSchema({
        verification: z.strictObject({ channel_id: snowflake(), attempts: z.int().positive() }),
      }),
      knownSections: [...CORE_SECTION_NAMES, 'verification'],
    });

    config.load();

    return { dir, config };
  };

  test('un rechargement valide met la section à jour', (t) => {
    const { dir, config } = withConfig(t);

    writeFileSync(join(dir, 'config.yml'), CONFIG.replace('attempts: 3', 'attempts: 5'), 'utf8');

    assert.equal(config.reload().ok, true);
    assert.equal(config.get('verification.attempts'), 5);
  });

  test('le fragment valide encore après rechargement, l\'ancienne section survit', (t) => {
    const { dir, config } = withConfig(t);

    // Configuration capture ses options une fois : sans cela, le rechargement
    // repartirait sur le schéma du seul noyau et la section cesserait d'être
    // validée — silencieusement, et seulement après le premier /reload.
    writeFileSync(join(dir, 'config.yml'), CONFIG.replace(`"${ID}"\n  attempts`, `${ID}\n  attempts`), 'utf8');

    const résultat = config.reload();

    assert.equal(résultat.ok, false);
    assert.equal(résultat.errors[0].key, 'verification.channel_id');
    assert.match(résultat.errors[0].message, /sans guillemets/);
    assert.equal(config.get('verification.attempts'), 3);
  });
});
