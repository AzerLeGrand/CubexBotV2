import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createCommandRegistry, isAllowed, roleIdsOf } from '../../../src/core/commands/index.js';

const OWNER = '111111111111111111';
const ADMIN = '222222222222222222';
const MEMBRE = '333333333333333333';

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

const TEXTS = {
  'commands.reload.description': 'Recharge la configuration.',
  'commands.reload.option.force': 'Forcer malgré les avertissements.',
};

const fakeConfig = (permissions) => ({
  get: (path, ...fallback) => {
    if (path in permissions) return permissions[path];
    if (fallback.length > 0) return fallback[0];
    throw new Error(`chemin de configuration inconnu : ${path}`);
  },
  text: (key) => TEXTS[key] ?? key,
});

const fakeEmbeds = (rendus) => ({
  render: (template, variables) => {
    rendus.push({ template, variables });
    return { title: template };
  },
});

/** Interaction factice : retient ce qui a été répondu. */
const fakeInteraction = ({ command = 'reload', roles = [], user = 'u1' } = {}) => {
  const replies = [];

  return {
    commandName: command,
    member: { roles },
    user: { id: user },
    deferred: false,
    replied: false,
    replies,
    reply: (payload) => {
      replies.push({ kind: 'reply', payload });
      return Promise.resolve();
    },
    followUp: (payload) => {
      replies.push({ kind: 'followUp', payload });
      return Promise.resolve();
    },
  };
};

const setup = (permissions = { 'commands.reload.allowed_roles': [OWNER, ADMIN] }) => {
  const logger = fakeLogger();
  const rendus = [];
  const registry = createCommandRegistry({
    config: fakeConfig(permissions),
    logger,
    embeds: fakeEmbeds(rendus),
  });

  return { registry, logger, rendus };
};

const RELOAD = (execute = () => {}) => ({
  name: 'reload',
  description_key: 'commands.reload.description',
  execute,
});

describe('isAllowed', () => {
  test('le littéral public ouvre à tous', () => {
    assert.equal(isAllowed('public', []), true);
  });

  test('un rôle de la liste suffit', () => {
    assert.equal(isAllowed([OWNER, ADMIN], [MEMBRE, ADMIN]), true);
    assert.equal(isAllowed([OWNER, ADMIN], [MEMBRE]), false);
  });

  test('refuse quand la commande n\'est pas configurée', () => {
    // Une entrée oubliée doit se remarquer par un refus, pas par un /ban
    // accessible à tous.
    for (const valeur of [undefined, null, [], 'tous', {}]) {
      assert.equal(isAllowed(valeur, [OWNER]), false, `valeur ${JSON.stringify(valeur)}`);
    }
  });
});

describe('roleIdsOf', () => {
  test('accepte un tableau', () => {
    assert.deepEqual(roleIdsOf({ roles: [OWNER] }), [OWNER]);
  });

  test('accepte une collection discord.js', () => {
    const cache = new Map([[OWNER, {}], [ADMIN, {}]]);

    assert.deepEqual(roleIdsOf({ roles: { cache } }), [OWNER, ADMIN]);
  });

  test('supporte un membre absent', () => {
    assert.deepEqual(roleIdsOf(undefined), []);
    assert.deepEqual(roleIdsOf({}), []);
  });
});

describe('register', () => {
  test('inscrit les commandes d\'un module', () => {
    const { registry } = setup();

    registry.register('core', [RELOAD()]);

    assert.equal(registry.size, 1);
    assert.equal(registry.has('reload'), true);
  });

  test('refuse un nom non conforme à Discord', () => {
    const { registry } = setup();

    for (const name of ['Reload', 'rechargement config', 'a'.repeat(33), '']) {
      assert.throws(() => registry.register('core', [{ ...RELOAD(), name }]), /nom attendu/);
    }
  });

  test('exige une clé de description, pas une description', () => {
    const { registry } = setup();
    const { description_key: _, ...sansCle } = RELOAD();

    assert.throws(
      () => registry.register('core', [{ ...sansCle, description: 'En clair' }]),
      /description_key/,
    );
  });

  test('exige une fonction execute', () => {
    const { registry } = setup();

    assert.throws(
      () => registry.register('core', [{ ...RELOAD(), execute: undefined }]),
      /« execute »/,
    );
  });

  test('refuse deux modules revendiquant le même nom', () => {
    const { registry } = setup();

    registry.register('core', [RELOAD()]);

    assert.throws(() => registry.register('tickets', [RELOAD()]), /déjà fournie par core/);
  });
});

describe('unconfigured', () => {
  test('liste les commandes sans entrée dans config.yml', () => {
    const { registry } = setup({});

    registry.register('core', [RELOAD()]);

    // À contrôler au démarrage : sans configuration une commande est refusée à
    // tous, et le découvrir à la première utilisation est trop tard.
    assert.deepEqual(registry.unconfigured(), ['reload']);
  });

  test('ne signale rien quand tout est configuré', () => {
    const { registry } = setup();

    registry.register('core', [RELOAD()]);

    assert.deepEqual(registry.unconfigured(), []);
  });
});

describe('toJSON', () => {
  test('résout les textes depuis messages.yml', () => {
    const { registry } = setup();

    registry.register('core', [RELOAD()]);

    assert.deepEqual(registry.toJSON(), [
      { name: 'reload', description: 'Recharge la configuration.' },
    ]);
  });

  test('résout aussi la description des options', () => {
    const { registry } = setup();

    registry.register('core', [
      {
        ...RELOAD(),
        options: [
          { name: 'force', type: 5, description_key: 'commands.reload.option.force' },
        ],
      },
    ]);

    assert.deepEqual(registry.toJSON()[0].options, [
      { name: 'force', type: 5, description: 'Forcer malgré les avertissements.' },
    ]);
  });
});

describe('handle', () => {
  test('exécute la commande quand le rôle est autorisé', async () => {
    const { registry } = setup();
    let exécutée = 0;

    registry.register('core', [RELOAD(() => (exécutée += 1))]);
    const interaction = fakeInteraction({ roles: [ADMIN] });

    await registry.handle(interaction);

    assert.equal(exécutée, 1);
    assert.deepEqual(interaction.replies, [], 'la commande répond elle-même');
  });

  test('refuse en éphémère au demandeur seul', async () => {
    const { registry, logger, rendus } = setup();
    registry.register('core', [RELOAD(() => assert.fail('ne doit pas s\'exécuter'))]);

    const interaction = fakeInteraction({ roles: [MEMBRE] });
    await registry.handle(interaction);

    assert.equal(interaction.replies[0].kind, 'reply');
    assert.equal(interaction.replies[0].payload.flags, 64);
    assert.equal(rendus[0].template, 'command_denied');

    // Aucune trace dans les salons de logs : seule une entrée de journal.
    assert.match(logger.of('info')[0].message, /refusée/);
  });

  test('refuse une commande non configurée en le signalant', async () => {
    const { registry, logger } = setup({});
    registry.register('core', [RELOAD()]);

    await registry.handle(fakeInteraction({ roles: [OWNER] }));

    assert.equal(logger.of('info')[0].context.configured, false);
  });

  test('répond sur une commande inconnue plutôt que de laisser l\'interaction pendante', async () => {
    const { registry, logger } = setup();

    const interaction = fakeInteraction({ command: 'disparue' });
    await registry.handle(interaction);

    assert.equal(interaction.replies.length, 1);
    assert.match(logger.of('error')[0].message, /commande inconnue/);
  });

  test('rattrape une commande en échec et répond quand même', async () => {
    const { registry, logger, rendus } = setup();
    registry.register('core', [
      RELOAD(() => {
        throw new Error('base indisponible');
      }),
    ]);

    const interaction = fakeInteraction({ roles: [OWNER] });
    await registry.handle(interaction);

    // Une interaction sans réponse laisse « L'application ne répond pas ».
    assert.equal(interaction.replies.length, 1);
    assert.equal(rendus[0].template, 'command_failed');
    assert.equal(logger.of('error')[0].context.expected, false);
  });

  test('emploie le gabarit porté par une erreur applicative', async () => {
    const { registry, logger, rendus } = setup();
    const { FeatureUnavailableError } = await import('../../../src/core/errors/index.js');

    registry.register('core', [
      RELOAD(() => {
        throw new FeatureUnavailableError('minecraft.link');
      }),
    ]);

    await registry.handle(fakeInteraction({ roles: [OWNER] }));

    assert.equal(rendus[0].template, 'feature_unavailable');
    assert.equal(logger.of('error')[0].context.expected, true);
  });

  test('poursuit avec followUp quand la réponse a déjà été différée', async () => {
    const { registry } = setup();
    registry.register('core', [
      RELOAD(() => {
        throw new Error('trop tard');
      }),
    ]);

    const interaction = { ...fakeInteraction({ roles: [OWNER] }), deferred: true };
    await registry.handle(interaction);

    assert.equal(interaction.replies[0].kind, 'followUp');
  });

  test('ne lève jamais, même si la réponse échoue', async () => {
    const { registry, logger } = setup();
    registry.register('core', [RELOAD()]);

    const interaction = fakeInteraction({ roles: [MEMBRE] });
    interaction.reply = () => Promise.reject(new Error('interaction expirée'));

    await assert.doesNotReject(() => registry.handle(interaction));
    assert.match(logger.of('error').at(-1).message, /réponse impossible/);
  });
});
