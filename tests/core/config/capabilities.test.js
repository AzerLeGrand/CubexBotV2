import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CapabilityRegistry } from '../../../src/core/config/capabilities.js';
import { verifyDiscordRefs } from '../../../src/core/config/discord-refs.js';

const SALON = '123456789012345678';
const CATEGORIE = '223456789012345678';
const ROLE = '323456789012345678';

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

/** Serveur factice : seul ce qui est déclaré ici existe. */
const fakeGuild = ({ roles = [], channels = {} } = {}) => ({
  roles: {
    fetch: (id) => (roles.includes(id) ? Promise.resolve({ id }) : Promise.resolve(null)),
  },
  channels: {
    fetch: (id) =>
      id in channels ? Promise.resolve({ id, type: channels[id] }) : Promise.resolve(null),
  },
});

const CONFIG = {
  bot: { log_channel_id: SALON },
  tickets: {
    panel_channel_id: SALON,
    categories: [
      { id: 'game', category_id: CATEGORIE },
      { id: 'store', category_id: '999999999999999999' },
    ],
  },
  roles: { staff: ROLE },
};

const run = (declarations, guild, config = CONFIG) => {
  const capabilities = new CapabilityRegistry();
  const logger = fakeLogger();

  return verifyDiscordRefs({ guild, config, declarations, capabilities, logger }).then((result) => ({
    result,
    capabilities,
    logger,
  }));
};

describe('CapabilityRegistry', () => {
  test('une capacité déclarée est active', () => {
    const registry = new CapabilityRegistry().declare('tickets.panel');

    assert.equal(registry.isEnabled('tickets.panel'), true);
    assert.equal(registry.reasonFor('tickets.panel'), null);
  });

  test('une capacité jamais déclarée est considérée active', () => {
    // Le contraire ferait taire toute fonctionnalité dont on aurait oublié la
    // déclaration, sans qu'elle soit en défaut.
    assert.equal(new CapabilityRegistry().isEnabled('inconnue'), true);
  });

  test('désactive en conservant le motif', () => {
    const registry = new CapabilityRegistry().disable('tickets.panel', 'salon introuvable');

    assert.equal(registry.isEnabled('tickets.panel'), false);
    assert.equal(registry.reasonFor('tickets.panel'), 'salon introuvable');
    assert.deepEqual(registry.disabled().map((state) => state.id), ['tickets.panel']);
  });

  test('réactive et efface le motif', () => {
    const registry = new CapabilityRegistry().disable('x', 'motif').enable('x');

    assert.equal(registry.isEnabled('x'), true);
    assert.equal(registry.reasonFor('x'), null);
  });

  test('reset remet tout à l\'état déclaré', () => {
    const registry = new CapabilityRegistry().disable('a', 'motif').disable('b', 'motif');

    registry.reset();

    assert.deepEqual(registry.disabled(), []);
    assert.equal(registry.list().length, 2, 'les capacités restent déclarées');
  });

  test('list rend des copies, pas l\'état interne', () => {
    const registry = new CapabilityRegistry().declare('a');

    registry.list()[0].enabled = false;

    assert.equal(registry.isEnabled('a'), true);
  });
});

describe('verifyDiscordRefs', () => {
  const DECLARATIONS = [
    { id: 'tickets.panel', critical: true, refs: [{ kind: 'channel', path: 'tickets.panel_channel_id' }] },
    {
      id: 'tickets.category.game',
      critical: false,
      refs: [{ kind: 'category', path: 'tickets.categories[game].category_id' }],
    },
    {
      id: 'tickets.category.store',
      critical: false,
      refs: [{ kind: 'category', path: 'tickets.categories[store].category_id' }],
    },
    { id: 'moderation', refs: [{ kind: 'role', path: 'roles.staff' }] },
  ];

  const GUILD = fakeGuild({
    roles: [ROLE],
    channels: { [SALON]: 0, [CATEGORIE]: 4 },
  });

  test('laisse actives les capacités dont les références existent, sans un mot', async () => {
    // Uniquement les déclarations saines : `tickets.category.store` pointe
    // délibérément vers une catégorie absente et est éprouvée plus bas.
    const saines = DECLARATIONS.filter((d) => d.id !== 'tickets.category.store');

    const { capabilities, logger } = await run(saines, GUILD);

    assert.equal(capabilities.isEnabled('tickets.panel'), true);
    assert.equal(capabilities.isEnabled('tickets.category.game'), true);
    assert.equal(capabilities.isEnabled('moderation'), true);

    // Référence valide : aucun message (socle §5.5).
    assert.deepEqual(logger.of('warn'), []);
    assert.deepEqual(logger.of('error'), []);
  });

  test('désactive la seule capacité dont la référence manque', async () => {
    const { result, capabilities, logger } = await run(DECLARATIONS, GUILD);

    assert.deepEqual(result.disabled, ['tickets.category.store']);
    assert.equal(capabilities.isEnabled('tickets.category.store'), false);
    assert.match(capabilities.reasonFor('tickets.category.store'), /catégorie introuvable/);

    // Les autres catégories continuent de fonctionner.
    assert.equal(capabilities.isEnabled('tickets.category.game'), true);
    assert.match(logger.of('warn')[0].message, /fonctionnalité désactivée/);
  });

  test('adresse les entrées de collection par leur clé id, pas par leur position', async () => {
    // Le fichier est réordonné : la capacité doit suivre l'entrée, pas l'index.
    const réordonné = {
      ...CONFIG,
      tickets: { ...CONFIG.tickets, categories: [...CONFIG.tickets.categories].reverse() },
    };

    const { capabilities } = await run(DECLARATIONS, GUILD, réordonné);

    assert.equal(capabilities.isEnabled('tickets.category.game'), true);
    assert.equal(capabilities.isEnabled('tickets.category.store'), false);
  });

  test('refuse une catégorie qui est en réalité un salon textuel', async () => {
    // Type 0 au lieu de 4 : créer un ticket dedans échouerait bien plus tard.
    const guild = fakeGuild({ roles: [ROLE], channels: { [SALON]: 0, [CATEGORIE]: 0 } });

    const { capabilities } = await run(DECLARATIONS, guild);

    assert.equal(capabilities.isEnabled('tickets.category.game'), false);
  });

  test('signale un chemin déclaré qui ne résout pas', async () => {
    const declarations = [{ id: 'x', refs: [{ kind: 'channel', path: 'tickets.absent_id' }] }];

    const { result, capabilities, logger } = await run(declarations, GUILD);

    assert.deepEqual(result.missingPaths, ['tickets.absent_id']);
    assert.equal(capabilities.isEnabled('x'), false);
    assert.match(logger.of('error')[0].message, /chemin inexistant/);
  });

  test('ne s\'arrête pas à la première référence manquante', async () => {
    const { result } = await run(
      [
        { id: 'a', refs: [{ kind: 'channel', path: 'tickets.categories[store].category_id' }] },
        { id: 'b', refs: [{ kind: 'role', path: 'roles.staff' }] },
      ],
      GUILD,
    );

    assert.deepEqual(result.disabled, ['a']);
    assert.equal(result.checked, 2, 'la déclaration suivante est vérifiée');
  });

  test('survit à une API qui lève au lieu de rendre null', async () => {
    const guild = {
      roles: { fetch: () => Promise.reject(new Error('Unknown Role')) },
      channels: { fetch: () => Promise.reject(new Error('Unknown Channel')) },
    };

    const { capabilities } = await run(DECLARATIONS, guild);

    assert.equal(capabilities.isEnabled('moderation'), false);
  });

  test('réactive une capacité dont la référence est revenue', async () => {
    // Rejoué à chaque rechargement à chaud : sans reset, l'état ne pourrait que
    // se dégrader, jamais se rétablir.
    const capabilities = new CapabilityRegistry();
    const logger = fakeLogger();
    const declarations = [{ id: 'moderation', refs: [{ kind: 'role', path: 'roles.staff' }] }];

    const options = (guild) => ({ guild, config: CONFIG, declarations, capabilities, logger });

    await verifyDiscordRefs(options(fakeGuild({ roles: [] })));
    assert.equal(capabilities.isEnabled('moderation'), false);

    await verifyDiscordRefs(options(fakeGuild({ roles: [ROLE] })));
    assert.equal(capabilities.isEnabled('moderation'), true);
    assert.equal(capabilities.reasonFor('moderation'), null);
  });
});
