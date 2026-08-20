import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AttachmentBuilder, AuditLogEvent, RESTJSONErrorCodes } from 'discord.js';

import { AUDIT_ACTION_NAMES } from '../../../../src/modules/logs/constants.js';
import { createAuditSource } from '../../../../src/modules/logs/discord/audit-source.js';
import { createRoleSource } from '../../../../src/modules/logs/discord/role-source.js';
import { createSender } from '../../../../src/modules/logs/discord/sender.js';

/**
 * Adaptateurs vers discord.js.
 *
 * **Le seul endroit du module où la bibliothèque est importée en test**, et
 * c'est délibéré : tout le reste — normalisation, corrélation, exclusions,
 * rendu — s'éprouve sans elle, et ces trois fichiers sont la couture.
 *
 * Ce qu'ils doivent garantir tient en trois phrases : la traduction est fidèle,
 * les noms d'action restent des NOMS, et rien ne lève sur un membre ou un salon
 * introuvable — deux situations parfaitement ordinaires.
 */

const MEMBRE = '123456789012345678';
const MODERATEUR = '111111111111111111';
const SALON = '222222222222222222';

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

// ---------------------------------------------------------------------------
// Journal d'audit
// ---------------------------------------------------------------------------

/** Entrée telle que discord.js la construit — la forme d'entrée de l'adaptateur. */
const auditEntry = (patch = {}) => ({
  id: '900000000000000001',
  action: AuditLogEvent.MessageDelete,
  executorId: MODERATEUR,
  targetId: MEMBRE,
  reason: 'nettoyage',
  changes: [],
  extra: { channel: { id: SALON }, count: 3 },
  createdAt: new Date('2026-08-18T14:32:07.512Z'),
  ...patch,
});

const fakeGuild = (entries, capture = []) => ({
  fetchAuditLogs: async (query) => {
    capture.push(query);

    return { entries: new Map(entries.map((entry) => [entry.id, entry])) };
  },
});

describe("source du journal d'audit", () => {
  test('traduit une entrée brute vers la forme normalisée', async () => {
    const source = createAuditSource({
      guild: fakeGuild([auditEntry()]),
      auditLogEvent: AuditLogEvent,
      logger: fakeLogger(),
    });

    const [entree] = await source({ actionName: 'MessageDelete', limit: 25 });

    assert.deepEqual(entree, {
      id: '900000000000000001',
      actionName: 'MessageDelete',
      executorId: MODERATEUR,
      targetId: MEMBRE,
      // Le salon vit dans `extra`, dont la forme change d'une action à l'autre.
      channelId: SALON,
      count: 3,
      createdAt: new Date('2026-08-18T14:32:07.512Z'),
      // Champ à part entière : la corrélation le lit et le fait suivre jusqu'à
      // `data`. Ce qui est lu par un consommateur mérite un nom dans le
      // contrat, pas une place dans un sac.
      reason: 'nettoyage',
      extra: { changes: [] },
    });
  });

  test('une entrée sans raison rend null, sans clé manquante', async () => {
    const source = createAuditSource({
      guild: fakeGuild([auditEntry({ reason: null })]),
      auditLogEvent: AuditLogEvent,
      logger: fakeLogger(),
    });

    const [entree] = await source({ actionName: 'MessageDelete', limit: 25 });

    assert.equal(entree.reason, null);
  });

  test('la raison est rendue telle quelle, sans coupure ni nettoyage', async () => {
    // Le bornage appartient à la corrélation, qui a la configuration. Deux
    // endroits qui tronquent finiraient par diverger.
    const longue = 'a'.repeat(4000);

    const source = createAuditSource({
      guild: fakeGuild([auditEntry({ reason: longue })]),
      auditLogEvent: AuditLogEvent,
      logger: fakeLogger(),
    });

    const [entree] = await source({ actionName: 'MessageDelete', limit: 25 });

    assert.equal(entree.reason, longue);
  });

  test("actionName est un NOM, jamais l'entier de l'API", async () => {
    // La table AUDIT_ACTIONS travaille sur des noms, et `isCounted()` compare
    // des noms. Un entier ici ferait échouer chaque comparaison en silence, et
    // le symptôme serait une attribution manquante, pas une erreur.
    const source = createAuditSource({
      guild: fakeGuild([auditEntry({ action: AuditLogEvent.MemberKick })]),
      auditLogEvent: AuditLogEvent,
      logger: fakeLogger(),
    });

    const [entree] = await source({ actionName: 'MemberKick', limit: 25 });

    assert.equal(entree.actionName, 'MemberKick');
    assert.equal(typeof entree.actionName, 'string');
  });

  test("l'entier demandé à l'API vient bien de l'énumération", async () => {
    const requetes = [];

    const source = createAuditSource({
      guild: fakeGuild([], requetes),
      auditLogEvent: AuditLogEvent,
      logger: fakeLogger(),
    });

    await source({ actionName: 'MemberBanAdd', limit: 7 });

    assert.deepEqual(requetes, [{ type: AuditLogEvent.MemberBanAdd, limit: 7 }]);
  });

  test('une action sans compteur vaut 1, jamais NaN', async () => {
    // Forme uniforme imposée par le contrat : le corrélateur ne doit pas avoir
    // à distinguer les actions à compteur des autres pour lire ce champ.
    const source = createAuditSource({
      guild: fakeGuild([auditEntry({ extra: null })]),
      auditLogEvent: AuditLogEvent,
      logger: fakeLogger(),
    });

    const [entree] = await source({ actionName: 'MemberBanAdd', limit: 25 });

    assert.equal(entree.count, 1);
    assert.equal(entree.channelId, null);
  });

  test('les noms de AUDIT_ACTIONS existent tous dans l\'énumération installée', () => {
    // Garde-fou de version : la vérification d'attach() tourne au démarrage du
    // bot, celle-ci tourne à chaque `npm test` — donc avant le déploiement.
    for (const nom of AUDIT_ACTION_NAMES) {
      assert.equal(typeof AuditLogEvent[nom], 'number', nom);
    }
  });

  test('un nom inconnu lève plutôt que d\'interroger une action indéfinie', async () => {
    const source = createAuditSource({
      guild: fakeGuild([]),
      auditLogEvent: AuditLogEvent,
      logger: fakeLogger(),
    });

    await assert.rejects(() => source({ actionName: 'CeciNExistePas', limit: 25 }), /CeciNExistePas/);
  });
});

// ---------------------------------------------------------------------------
// Rôles
// ---------------------------------------------------------------------------

const apiError = (code) => Object.assign(new Error('erreur API'), { code });

const guildWithMember = (roles) => ({
  members: {
    cache: new Map([[MEMBRE, { roles: { cache: new Map(roles.map((id) => [id, { id }])) } }]]),
    fetch: async () => {
      throw new Error('le cache aurait dû suffire');
    },
  },
});

describe('source des rôles', () => {
  test('rend les identifiants de rôles du membre', async () => {
    const resolve = createRoleSource({ guild: guildWithMember(['r1', 'r2']), logger: fakeLogger() });

    assert.deepEqual(await resolve(MEMBRE), ['r1', 'r2']);
  });

  test('un membre introuvable rend une liste vide, jamais une exception', async () => {
    // C'est le cas ORDINAIRE : le membre dont on journalise le départ vient
    // précisément de quitter le serveur.
    const logger = fakeLogger();

    const resolve = createRoleSource({
      guild: {
        members: {
          cache: new Map(),
          fetch: async () => {
            throw apiError(RESTJSONErrorCodes.UnknownMember);
          },
        },
      },
      logger,
    });

    assert.deepEqual(await resolve(MEMBRE), []);
    assert.equal(logger.of('warn').length, 0, 'un départ n\'est pas une anomalie');
    assert.equal(logger.of('debug').length, 1);
  });

  test('un échec qui n\'est PAS un membre inconnu est signalé', async () => {
    // Une permission retirée rend les exclusions par rôle inopérantes en
    // silence : on ne lève pas, donc personne d'autre ne le verra.
    const logger = fakeLogger();

    const resolve = createRoleSource({
      guild: {
        members: {
          cache: new Map(),
          fetch: async () => {
            throw apiError(RESTJSONErrorCodes.MissingAccess);
          },
        },
      },
      logger,
    });

    assert.deepEqual(await resolve(MEMBRE), []);
    assert.equal(logger.of('warn').length, 1);
  });

  test('le cache est consulté avant l\'API', async () => {
    // Une requête par événement serait une dépense pure : `fetch` lève ici, et
    // le test échouerait s'il était appelé.
    const resolve = createRoleSource({ guild: guildWithMember(['r1']), logger: fakeLogger() });

    assert.deepEqual(await resolve(MEMBRE), ['r1']);
  });
});

// ---------------------------------------------------------------------------
// Envoi
// ---------------------------------------------------------------------------

const clientWithChannel = (channel) => ({
  channels: {
    cache: new Map(channel === null ? [] : [[SALON, channel]]),
    fetch: async () => {
      throw apiError(RESTJSONErrorCodes.UnknownChannel);
    },
  },
});

describe('envoi', () => {
  test('convertit { name, content } en pièce jointe discord.js', async () => {
    const envois = [];
    const send = createSender({
      client: clientWithChannel({ send: async (message) => envois.push(message) }),
      logger: fakeLogger(),
    });

    await send({
      channelId: SALON,
      embeds: [{ description: 'x' }],
      attachments: [{ name: 'message_delete-1.txt', content: 'contenu intégral' }],
    });

    const [message] = envois;

    assert.equal(message.embeds.length, 1);
    assert.equal(message.files.length, 1);
    assert.ok(message.files[0] instanceof AttachmentBuilder);
    assert.equal(message.files[0].name, 'message_delete-1.txt');
    assert.equal(message.files[0].attachment.toString('utf8'), 'contenu intégral');
  });

  test('sans pièce jointe, la liste de fichiers est vide', async () => {
    const envois = [];
    const send = createSender({
      client: clientWithChannel({ send: async (message) => envois.push(message) }),
      logger: fakeLogger(),
    });

    await send({ channelId: SALON, embeds: [{ description: 'x' }] });

    assert.deepEqual(envois[0].files, []);
  });

  test('un salon introuvable ne lève pas, et se signale en warn', async () => {
    // Le dispatcher abandonne déjà : lui renvoyer une exception ne lui
    // apprendrait rien qu'il puisse traiter autrement. La ligne est en base.
    const logger = fakeLogger();
    const send = createSender({ client: clientWithChannel(null), logger });

    assert.equal(await send({ channelId: SALON, embeds: [] }), null);
    assert.equal(logger.of('warn').length, 1);
    assert.equal(logger.of('error').length, 0, 'un salon supprimé n\'est pas un défaut du bot');
  });

  test('un salon qui n\'accepte pas de message ne lève pas', async () => {
    // Une catégorie, un salon de forum, un identifiant qui désigne autre chose.
    const logger = fakeLogger();
    const send = createSender({ client: clientWithChannel({ name: 'une catégorie' }), logger });

    assert.equal(await send({ channelId: SALON, embeds: [] }), null);
    assert.equal(logger.of('warn').length, 1);
  });

  test('une permission d\'écriture retirée ne lève pas', async () => {
    const logger = fakeLogger();
    const send = createSender({
      client: clientWithChannel({
        send: async () => {
          throw apiError(RESTJSONErrorCodes.MissingPermissions);
        },
      }),
      logger,
    });

    assert.equal(await send({ channelId: SALON, embeds: [{ description: 'x' }] }), null);
    assert.equal(logger.of('warn').length, 1);
  });
});
