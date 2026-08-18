import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { loadYamlFiles } from '../../../src/core/config/loader.js';
import { buildConfigSchema } from '../../../src/core/config/schema/core.schema.js';
import { loadManifests, PRIVILEGED_INTENTS, resolveIntents } from '../../../src/core/loader/manifests.js';
import { LOG_CHANNELS, LOG_EVENTS } from '../../../src/modules/logs/constants.js';
import { intents, schema } from '../../../src/modules/logs/manifest.js';

/**
 * Fragment de configuration du module de journalisation.
 *
 * Deuxième module du projet à en déclarer un, et le premier à porter une
 * validation croisée INTERNE au fragment : un événement doit pointer vers un
 * salon qui existe, ce qu'aucune validation de forme ne peut dire.
 */

const ID = '123456789012345678';

/** Un identifiant distinct par salon : un test qui les confondrait passerait à tort. */
const CHANNELS = Object.fromEntries(
  LOG_CHANNELS.map((key, index) => [key, `15033552481550380${10 + index}`]),
);

/** Tous les événements déclarés, chacun sur un salon existant. */
const EVENTS = Object.fromEntries(
  LOG_EVENTS.map((event) => [event, { enabled: true, channel: LOG_CHANNELS[0] }]),
);

/** Section conforme, sur laquelle chaque cas de refus applique sa dégradation. */
const SECTION = {
  channels: CHANNELS,
  events: EVENTS,
  grouping: { window_seconds: 5 },
  attachment_threshold: 1024,
  audit: { correlation_window_seconds: 5 },
  catchup: { max_hours: 24 },
  retention: { message_content_days: 30, structural_days: 90 },
  exclusions: { channels: [], users: [], roles: [] },
};

const failure = (section) => {
  const result = schema.safeParse(section);
  assert.equal(result.success, false, 'la section aurait dû être refusée');

  return result.error.issues;
};

const paths = (section) => failure(section).map((issue) => issue.path.join('.'));

describe('fragment de schéma', () => {
  test('accepte une section conforme', () => {
    const result = schema.safeParse(SECTION);

    assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
  });

  test('refuse une clé inconnue dans la section', () => {
    const [issue] = failure({ ...SECTION, oups: 1 });

    assert.equal(issue.code, 'unrecognized_keys');
  });

  test('seuls les réglages techniques portent un défaut', () => {
    // Aucun ne change ce qui est ENREGISTRÉ, seulement la façon dont c'est
    // restitué : leur absence ne fait rien perdre.
    const {
      grouping: _g,
      attachment_threshold: _a,
      audit: _au,
      catchup: _c,
      ...section
    } = SECTION;

    const result = schema.safeParse(section);

    assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
    assert.equal(result.data.grouping.window_seconds > 0, true);
    assert.equal(result.data.attachment_threshold > 0, true);
    assert.equal(result.data.audit.correlation_window_seconds > 0, true);
    assert.equal(result.data.catchup.max_hours > 0, true);
  });
});

describe('salons de restitution', () => {
  test('aucun identifiant de salon n\'a de défaut', () => {
    for (const key of LOG_CHANNELS) {
      const { [key]: _absent, ...channels } = CHANNELS;

      assert.deepEqual(
        paths({ ...SECTION, channels }),
        [`channels.${key}`],
        `logs.channels.${key} devrait être obligatoire`,
      );
    }
  });

  test('une sous-section channels écrite mais vide nomme ses cinq clés', () => {
    // `channels:` sans corps : js-yaml rend null. Le geste d'édition est le même
    // qu'à la racine — on écrit l'en-tête, on est interrompu.
    for (const vide of [null, {}]) {
      assert.deepEqual(
        paths({ ...SECTION, channels: vide }),
        LOG_CHANNELS.map((key) => `channels.${key}`),
        `channels: ${JSON.stringify(vide)}`,
      );
    }
  });

  test('refuse un identifiant écrit sans guillemets', () => {
    // La panne qui a arrêté la version précédente du bot : au-delà de 16
    // chiffres, un nombre YAML est tronqué silencieusement à la lecture.
    const [issue] = failure({
      ...SECTION,
      channels: { ...CHANNELS, moderation: 1503355380040732672 },
    });

    assert.match(issue.message, /sans guillemets/);
  });
});

describe('rétention', () => {
  test('aucune des deux durées n\'a de défaut', () => {
    // Un défaut silencieux sur une rétention, c'est une donnée personnelle
    // conservée plus longtemps que prévu sans que personne ne le sache.
    for (const key of ['message_content_days', 'structural_days']) {
      const { [key]: _absent, ...retention } = SECTION.retention;

      assert.deepEqual(paths({ ...SECTION, retention }), [`retention.${key}`]);
    }
  });

  test('la section entière est obligatoire, et nomme ses deux clés', () => {
    const { retention: _absente, ...section } = SECTION;

    assert.deepEqual(paths(section), [
      'retention.message_content_days',
      'retention.structural_days',
    ]);
  });

  test('accepte les deux durées quand elles sont fournies', () => {
    const result = schema.safeParse({
      ...SECTION,
      retention: { message_content_days: 7, structural_days: 365 },
    });

    assert.equal(result.success, true);
    assert.equal(result.data.retention.message_content_days, 7);
    assert.equal(result.data.retention.structural_days, 365);
  });

  test('refuse une rétention nulle ou négative', () => {
    // Zéro purgerait tout l'historique à la première exécution nocturne.
    for (const value of [0, -1, 1.5, '30']) {
      assert.equal(
        schema.safeParse({
          ...SECTION,
          retention: { ...SECTION.retention, message_content_days: value },
        }).success,
        false,
        `${value}`,
      );
    }
  });
});

describe('listes d\'exclusion', () => {
  test('les trois listes vides sont acceptées', () => {
    // Raisonnement INVERSE de allowedRoles() : une liste allowed_roles vidée
    // ouvrirait /ban à tous, alors qu'une exclusion vide est l'état neutre et
    // sûr — tout est journalisé, ce que le module est fait pour faire.
    const result = schema.safeParse({
      ...SECTION,
      exclusions: { channels: [], users: [], roles: [] },
    });

    assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
  });

  test('accepte des listes renseignées', () => {
    const result = schema.safeParse({
      ...SECTION,
      exclusions: { channels: [ID], users: [ID, '987654321098765432'], roles: [] },
    });

    assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
  });

  test('les trois clés restent obligatoires', () => {
    for (const key of ['channels', 'users', 'roles']) {
      const { [key]: _absente, ...exclusions } = SECTION.exclusions;

      assert.deepEqual(paths({ ...SECTION, exclusions }), [`exclusions.${key}`]);
    }
  });

  test('refuse un identifiant mal formé dans une liste', () => {
    // La liste est vide par défaut, pas laxiste : ce qu'elle contient reste un
    // identifiant Discord.
    assert.equal(
      schema.safeParse({ ...SECTION, exclusions: { ...SECTION.exclusions, users: ['42'] } }).success,
      false,
    );

    const [issue] = failure({
      ...SECTION,
      exclusions: { ...SECTION.exclusions, roles: [123456789012345678] },
    });

    assert.match(issue.message, /sans guillemets/);
  });
});

describe('événements', () => {
  test('la liste déclarée est exactement celle de la spec', () => {
    // Second exemplaire de la liste, délibérément : c'est ce qui fait de ce test
    // un contrôle plutôt qu'un miroir de constants.js.
    assert.deepEqual(LOG_EVENTS, [
      'message_delete',
      'message_edit',
      'message_bulk_delete',
      'voice_join',
      'voice_leave',
      'voice_move',
      'voice_server_mute',
      'voice_server_deafen',
      'voice_suppress',
      'member_join',
      'member_leave',
      'member_nickname',
      'member_role_add',
      'member_role_remove',
      'role_create',
      'role_delete',
      'role_update',
      'channel_create',
      'channel_delete',
      'channel_update',
      'channel_permissions_update',
      'webhook_update',
      'emoji_create',
      'emoji_delete',
      'emoji_update',
      'invite_create',
      'invite_delete',
      'guild_update',
      'member_ban',
      'member_unban',
      'member_kick',
      'member_timeout',
      'automod_action',
    ]);

    // Trois décisions prises : aucun changement d'avatar, une seule ligne pour
    // l'exclusion temporaire, un seul événement de webhook.
    assert.equal(LOG_EVENTS.filter((event) => event.includes('avatar')).length, 0);
    assert.equal(LOG_EVENTS.filter((event) => event === 'member_timeout').length, 1);
    assert.deepEqual(LOG_EVENTS.filter((event) => event.startsWith('webhook')), ['webhook_update']);
  });

  test('accepte la totalité de la liste, chacun avec son salon', () => {
    const result = schema.safeParse(SECTION);

    assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
    assert.deepEqual(Object.keys(result.data.events).sort(), [...LOG_EVENTS].sort());
  });

  test('chaque événement est obligatoire', () => {
    // Un z.record() ouvert accepterait « messsage_delete », qui ne serait jamais
    // journalisé pendant que le vrai resterait sans réglage.
    for (const event of ['message_delete', 'guild_update', 'automod_action']) {
      const { [event]: _absent, ...events } = EVENTS;

      assert.deepEqual(paths({ ...SECTION, events }), [
        `events.${event}.enabled`,
        `events.${event}.channel`,
      ]);
    }
  });

  test('refuse un événement inconnu', () => {
    const [issue] = failure({
      ...SECTION,
      events: { ...EVENTS, messsage_delete: { enabled: true, channel: 'messages' } },
    });

    assert.equal(issue.code, 'unrecognized_keys');
  });

  test('enabled attend un booléen', () => {
    assert.equal(
      schema.safeParse({
        ...SECTION,
        events: { ...EVENTS, message_edit: { enabled: 'oui', channel: 'messages' } },
      }).success,
      false,
    );
  });
});

describe('validation croisée : événement vers salon', () => {
  const withChannel = (event, channel) => ({
    ...SECTION,
    events: { ...EVENTS, [event]: { enabled: true, channel } },
  });

  test('refuse un salon qui n\'est aucune clé de logs.channels', () => {
    const issues = failure(withChannel('member_ban', 'moderations'));

    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].path, ['events', 'member_ban', 'channel']);
  });

  test('le message cite l\'événement fautif et la valeur reçue', () => {
    const [issue] = failure(withChannel('member_ban', 'moderations'));

    assert.match(issue.message, /member_ban/);
    assert.match(issue.message, /moderations/);
    // Et la liste de ce qui était attendu, pour que la correction soit lisible
    // sans ouvrir le code.
    for (const key of LOG_CHANNELS) assert.match(issue.message, new RegExp(key));
  });

  test('signale chaque événement fautif, pas seulement le premier', () => {
    const issues = failure({
      ...SECTION,
      events: {
        ...EVENTS,
        message_delete: { enabled: true, channel: 'messages ' },
        voice_join: { enabled: true, channel: 'Voice' },
      },
    });

    assert.deepEqual(
      issues.map((issue) => issue.path.join('.')),
      ['events.message_delete.channel', 'events.voice_join.channel'],
    );
  });

  test('accepte chacune des cinq clés existantes', () => {
    for (const channel of LOG_CHANNELS) {
      assert.equal(schema.safeParse(withChannel('message_delete', channel)).success, true, channel);
    }
  });

  test('un événement désactivé n\'échappe pas au contrôle', () => {
    // Le réactiver six mois plus tard ne doit pas révéler une clé morte écrite
    // et oubliée entre-temps.
    assert.equal(schema.safeParse(withChannel('emoji_update', 'inexistant')).success, false);
  });
});

describe('déclaration au noyau', () => {
  test('le manifeste est découvert et son fragment porte le nom du dossier', async () => {
    const { modules, fragments } = await loadManifests();

    assert.ok(modules.includes('logs'));
    assert.equal(fragments.logs, schema);
  });

  test('la section livrée dans config.yml satisfait le fragment', () => {
    const { files } = loadYamlFiles();
    const result = schema.safeParse(files.config.logs);

    assert.equal(result.success, true, JSON.stringify(result.error?.issues, null, 2));
  });

  test('le fragment reste montable dans le schéma du noyau', () => {
    // `.superRefine()` ne doit pas empêcher le `.prefault({})` que
    // buildConfigSchema() applique à la racine de chaque fragment : sans lui,
    // une section absente produirait un « expected object » posé sur le groupe
    // entier au lieu de la liste des clés à écrire.
    const composed = buildConfigSchema({ logs: schema });
    const result = composed.safeParse({});

    assert.equal(result.success, false);

    const chemins = result.error.issues.map((issue) => issue.path.join('.'));

    assert.ok(chemins.includes('logs.channels.messages'));
    assert.ok(chemins.includes('logs.retention.structural_days'));
    assert.ok(!chemins.includes('logs'), 'la section ne doit pas figurer seule');
  });
});

describe('intents', () => {
  test('déclare les dix intents de la journalisation', () => {
    assert.deepEqual(intents, [
      'Guilds',
      'GuildMembers',
      'GuildMessages',
      'MessageContent',
      'GuildVoiceStates',
      'GuildModeration',
      'GuildExpressions',
      'GuildWebhooks',
      'GuildInvites',
      'AutoModerationExecution',
    ]);
  });

  test('les trois intents absents de la table de la spec sont bien là', () => {
    // Omission de la spec §11 : sans eux, les émojis, les webhooks et les
    // invitations ne remontent jamais en direct.
    for (const intent of ['GuildExpressions', 'GuildWebhooks', 'GuildInvites']) {
      assert.ok(intents.includes(intent), intent);
    }
  });

  test('tous les noms sont résolus par la passerelle', () => {
    // GuildExpressions et GuildEmojisAndStickers coexistent dans discord.js :
    // on écrit le nom courant, et ce test prouve qu'il est bien connu de la
    // version installée.
    const resolved = resolveIntents(intents);

    assert.deepEqual(resolved.names, intents);
    assert.equal(resolved.bits.every((bit) => Number.isInteger(bit)), true);
  });

  test('deux privilégiés seulement, à cocher dans le portail développeur', () => {
    const { privileged } = resolveIntents(intents);

    assert.deepEqual(privileged, ['GuildMembers', 'MessageContent']);
    assert.deepEqual(
      intents.filter((intent) => PRIVILEGED_INTENTS.includes(intent)),
      privileged,
    );
  });

  test('remontent dans l\'union du noyau', async () => {
    const { intents: declared } = await loadManifests();

    for (const intent of intents) assert.ok(declared.includes(intent), intent);

    // Union telle que src/index.js la construit. `Guilds` est déclaré par le
    // noyau ET par ce module : la déduplication doit le rendre une seule fois.
    const { names } = resolveIntents(['Guilds', ...declared]);

    assert.equal(names.filter((intent) => intent === 'Guilds').length, 1);
    for (const intent of intents) assert.ok(names.includes(intent), intent);
  });
});
