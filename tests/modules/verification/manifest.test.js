import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildConfigSchema, CORE_SECTION_NAMES } from '../../../src/core/config/schema/core.schema.js';
import { loadYamlFiles } from '../../../src/core/config/loader.js';
import { loadManifests, resolveIntents } from '../../../src/core/loader/manifests.js';
import { intents, schema } from '../../../src/modules/verification/manifest.js';

/**
 * Le premier module du projet, et donc la première mise à l'épreuve réelle du
 * mécanisme de fragments du socle 0.2 : jusqu'ici il n'avait tourné que sur des
 * modules de test.
 */

const ID = '123456789012345678';

/** Section conforme, sur laquelle chaque cas de refus applique sa dégradation. */
const SECTION = {
  channel_id: ID,
  member_role_id: ID,
  challenge: {
    type: 'image',
    code_length: 6,
    ttl_seconds: 300,
    alphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
    input: { case_sensitive: false, strip_whitespace: true },
    image: {
      width: 320,
      height: 110,
      font_path: 'assets/fonts/DejaVuSans-Bold.ttf',
      font_size: 52,
      background: '#FFFFFF',
      text_color: '#1A1A1A',
      noise_lines: 6,
      noise_dots: 220,
      distortion: 0.35,
    },
  },
  max_attempts: 5,
  alert: { channel_id: ID, exhausted_role_id: ID, failure_role_id: ID },
  log: { channel_id: ID },
  retention: { history_days: 90 },
};

/** Applique une modification profonde sans toucher à l'original. */
const withChallenge = (patch) => ({
  ...SECTION,
  challenge: { ...SECTION.challenge, ...patch },
});

const withImage = (patch) => withChallenge({ image: { ...SECTION.challenge.image, ...patch } });

const failure = (section) => {
  const result = schema.safeParse(section);
  assert.equal(result.success, false, 'la section aurait dû être refusée');

  return result.error.issues;
};

describe('fragment de schéma', () => {
  test('accepte une section conforme', () => {
    const result = schema.safeParse(SECTION);

    assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
  });

  test('les deux seuls réglages techniques portent un défaut', () => {
    const result = schema.safeParse(SECTION);

    // Ni l'un ni l'autre ne change ce que voit un membre : la fréquence du
    // balayage de la mémoire, et le seuil au-delà duquel un rendu est signalé
    // comme lent. Tout le reste — identifiants, seuils, rétention — doit être
    // écrit, son absence bloque le démarrage.
    assert.equal(result.data.challenge.sweep_interval_seconds > 0, true);
    assert.equal(result.data.challenge.image.slow_render_ms > 0, true);
  });

  test('refuse une clé inconnue dans la section', () => {
    const [issue] = failure({ ...SECTION, oups: 1 });

    assert.equal(issue.code, 'unrecognized_keys');
  });
});

describe('clés obligatoires', () => {
  test('aucun identifiant, aucun seuil, aucune rétention n\'a de défaut', () => {
    // Un défaut silencieux sur une rétention, c'est une donnée personnelle
    // conservée plus longtemps que prévu sans que personne ne le sache.
    for (const key of ['channel_id', 'member_role_id', 'max_attempts', 'alert', 'log', 'retention']) {
      const { [key]: _absent, ...section } = SECTION;

      assert.equal(schema.safeParse(section).success, false, `${key} devrait être obligatoire`);
    }
  });

  test('nomme la clé manquante avec son chemin complet', () => {
    const [issue] = failure({ ...SECTION, retention: {} });

    assert.deepEqual(issue.path, ['retention', 'history_days']);
  });

  test('descend jusqu\'au fond de l\'arbre', () => {
    const { font_path: _absent, ...image } = SECTION.challenge.image;
    const [issue] = failure(withChallenge({ image }));

    assert.deepEqual(issue.path, ['challenge', 'image', 'font_path']);
  });

  test('une sous-section écrite mais vide nomme ses clés manquantes', () => {
    // `retention:` sans corps : js-yaml rend null. Le geste d'édition est le
    // même qu'à la racine — on écrit l'en-tête, on est interrompu — et le
    // diagnostic doit l'être aussi, sans quoi il redevient un « expected
    // object » posé sur le groupe entier.
    for (const vide of [null, {}]) {
      assert.deepEqual(
        failure({ ...SECTION, retention: vide }).map((issue) => issue.path.join('.')),
        ['retention.history_days'],
        `retention: ${JSON.stringify(vide)}`,
      );
    }
  });

  test('vaut à toutes les profondeurs', () => {
    assert.deepEqual(
      failure({ ...SECTION, alert: null }).map((issue) => issue.path.join('.')),
      ['alert.channel_id', 'alert.exhausted_role_id', 'alert.failure_role_id'],
    );

    assert.deepEqual(
      failure(withChallenge({ input: null })).map((issue) => issue.path.join('.')),
      ['challenge.input.case_sensitive', 'challenge.input.strip_whitespace'],
    );
  });
});

describe('identifiants Discord', () => {
  test('refuse un identifiant écrit sans guillemets', () => {
    // La panne qui a arrêté la version précédente du bot : au-delà de 16
    // chiffres, un nombre YAML est tronqué silencieusement à la lecture.
    for (const [key, section] of [
      ['channel_id', { ...SECTION, channel_id: 123456789012345678 }],
      ['member_role_id', { ...SECTION, member_role_id: 123456789012345678 }],
      ['alert.channel_id', { ...SECTION, alert: { ...SECTION.alert, channel_id: 123456789012345678 } }],
      ['log.channel_id', { ...SECTION, log: { channel_id: 123456789012345678 } }],
    ]) {
      const [issue] = failure(section);

      assert.match(issue.message, /sans guillemets/, `pour ${key}`);
    }
  });

  test('refuse un identifiant mal formé', () => {
    assert.equal(schema.safeParse({ ...SECTION, channel_id: '42' }).success, false);
  });
});

describe('paramètres de l\'épreuve', () => {
  test('n\'accepte que le type image tant que web n\'est pas écrit', () => {
    // Accepter une valeur dont l'implémentation n'existe pas ferait démarrer un
    // bot qui ne vérifierait personne.
    assert.equal(schema.safeParse(withChallenge({ type: 'web' })).success, false);
    assert.equal(schema.safeParse(withChallenge({ type: 'image' })).success, true);
  });

  test('refuse un alphabet trop court ou à caractères répétés', () => {
    for (const value of ['ABC', 'AABCDEFGHJK', 'ABCDEFGHJA']) {
      const [issue] = failure(withChallenge({ alphabet: value }));

      assert.match(issue.message, /au moins 10 caractères distincts/, `pour ${value}`);
    }
  });

  test('accepte un alphabet ambigu : la spec le veut configurable', () => {
    // L'exclusion de 0, O, 1, I et l est un réglage, pas une règle de schéma :
    // la figer interdirait de l'ajuster à l'usage.
    assert.equal(schema.safeParse(withChallenge({ alphabet: 'ABCDEFGO01Il' })).success, true);
  });

  test('borne la longueur du code', () => {
    for (const value of [3, 13, 0, -1]) {
      assert.equal(schema.safeParse(withChallenge({ code_length: value })).success, false, `${value}`);
    }

    for (const value of [4, 6, 12]) {
      assert.equal(schema.safeParse(withChallenge({ code_length: value })).success, true, `${value}`);
    }
  });

  test('refuse une durée de validité nulle', () => {
    assert.equal(schema.safeParse(withChallenge({ ttl_seconds: 0 })).success, false);
  });
});

describe('paramètres de rendu', () => {
  test('accepte un bruit nul, refuse un bruit négatif', () => {
    // Une image sans bruit est un réglage légitime : duration(), qui refuse
    // zéro, ne conviendrait pas ici.
    assert.equal(schema.safeParse(withImage({ noise_lines: 0, noise_dots: 0 })).success, true);
    assert.equal(schema.safeParse(withImage({ noise_dots: -1 })).success, false);
  });

  test('refuse une dimension nulle, avec un message qui ne parle pas de durée', () => {
    const [issue] = failure(withImage({ width: 0 }));

    assert.match(issue.message, /entier strictement positif/);
    assert.doesNotMatch(issue.message, /durée/, 'un width: 0 n\'est pas une histoire de temps');
  });

  test('borne la déformation entre 0 et 1', () => {
    for (const value of [-0.1, 1.1, 2]) {
      assert.equal(schema.safeParse(withImage({ distortion: value })).success, false, `${value}`);
    }

    for (const value of [0, 0.35, 1]) {
      assert.equal(schema.safeParse(withImage({ distortion: value })).success, true, `${value}`);
    }
  });

  test('refuse une couleur qui n\'est pas hexadécimale', () => {
    assert.equal(schema.safeParse(withImage({ background: 'blanc' })).success, false);
  });

  test('refuse un chemin de police non portable', () => {
    // Valeur versionnée, lue par le poste Windows et par le VPS Debian : elle
    // doit être jugée de la même façon des deux côtés.
    for (const value of [
      'C:\\polices\\DejaVuSans-Bold.ttf',
      '/usr/share/fonts/DejaVuSans-Bold.ttf',
      'assets\\fonts\\DejaVuSans-Bold.ttf',
    ]) {
      assert.equal(schema.safeParse(withImage({ font_path: value })).success, false, value);
    }
  });
});

describe('section montée dans le schéma du noyau', () => {
  const CORE = {
    bot: { guild_id: ID, timezone: 'Europe/Paris' },
    commands: { reload: { allowed_roles: [ID] } },
    database: { file: 'data/cubex.sqlite', busy_timeout_ms: 5000 },
    logging: { level: 'info', directory: 'logs', file_prefix: 'cubex', retention_days: 30 },
    purge: { hour: 4 },
    minecraft: { enabled: false },
  };

  const composed = buildConfigSchema({ verification: schema });

  test('une section absente refuse le démarrage avec la liste des clés manquantes', () => {
    const result = composed.safeParse(CORE);

    assert.equal(result.success, false);

    const chemins = result.error.issues.map((issue) => issue.path.join('.'));

    // Jusqu'aux feuilles, jamais un groupe seul : c'est la liste de ce qu'il
    // faut écrire, pas celle de ce qui est vide.
    for (const groupe of ['verification.challenge', 'verification.alert', 'verification.retention']) {
      assert.ok(!chemins.includes(groupe), `${groupe} ne doit pas figurer seul`);
    }

    for (const feuille of [
      'verification.channel_id',
      'verification.challenge.image.font_path',
      'verification.challenge.input.case_sensitive',
      'verification.alert.failure_role_id',
      'verification.log.channel_id',
      'verification.retention.history_days',
    ]) {
      assert.ok(chemins.includes(feuille), `${feuille} devrait être signalée`);
    }
  });

  test('une section vide produit le même diagnostic', () => {
    // `verification:` sans corps : js-yaml rend null, pas undefined. Le socle
    // 0.2 normalise le cas — vérifié ici sur un vrai module, pas sur un
    // fragment de test.
    const attendu = composed.safeParse(CORE).error.issues.map((issue) => issue.path.join('.'));

    for (const vide of [null, {}]) {
      const result = composed.safeParse({ ...CORE, verification: vide });

      assert.equal(result.success, false, `section ${JSON.stringify(vide)}`);
      assert.deepEqual(result.error.issues.map((issue) => issue.path.join('.')), attendu);
    }
  });

  test('n\'écrase aucune section du noyau', () => {
    for (const section of CORE_SECTION_NAMES) {
      const { [section]: _absente, ...reste } = CORE;

      assert.equal(
        composed.safeParse({ ...reste, verification: SECTION }).success,
        false,
        `la section ${section} reste obligatoire`,
      );
    }
  });
});

describe('déclaration au noyau', () => {
  test('le manifeste est découvert et son fragment porte le nom du dossier', async () => {
    const { modules, fragments } = await loadManifests();

    assert.ok(modules.includes('verification'));
    assert.equal(fragments.verification, schema);
  });

  test('les intents déclarés remontent dans l\'union du noyau', async () => {
    const { intents: declared } = await loadManifests();

    for (const intent of intents) assert.ok(declared.includes(intent), intent);

    // Union telle que src/index.js la construit : le noyau garde Guilds en
    // propre, les modules y ajoutent les leurs.
    const resolved = resolveIntents(['Guilds', ...declared]);

    assert.deepEqual(resolved.names, ['Guilds', 'GuildMembers', 'GuildMessages']);
    assert.deepEqual(resolved.privileged, ['GuildMembers'], 'à cocher dans le portail développeur');
  });

  test('la section livrée dans config.yml satisfait le fragment', () => {
    const { files } = loadYamlFiles();
    const result = schema.safeParse(files.config.verification);

    assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
  });
});
