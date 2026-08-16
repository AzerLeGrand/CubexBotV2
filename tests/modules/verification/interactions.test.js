import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CapabilityRegistry } from '../../../src/core/config/capabilities.js';
import { decodeCustomId } from '../../../src/core/components/index.js';
import { EPHEMERAL } from '../../../src/core/discord/flags.js';
import { createComponents } from '../../../src/modules/verification/components.js';
import { ACTIONS, CODE_FIELD, OUTCOMES } from '../../../src/modules/verification/constants.js';
import { events as moduleEvents } from '../../../src/modules/verification/index.js';
import { ensureWelcome, useRepository } from '../../../src/modules/verification/welcome.js';

/**
 * Le parcours vu de Discord : boutons, modale, alertes, republication.
 *
 * Les objets d'interaction sont factices — ce qui se teste ici est l'ordre des
 * appels et le gabarit choisi, pas discord.js.
 */

const MEMBRE = '123456789012345678';
const SALON = '222222222222222222';
const ROLE = '333333333333333333';
const SALON_ALERTE = '444444444444444444';
const SALON_LOG = '555555555555555555';

const REGLAGES = {
  'verification.channel_id': SALON,
  'verification.member_role_id': ROLE,
  'verification.challenge.ttl_seconds': 300,
  'verification.alert.channel_id': SALON_ALERTE,
  'verification.alert.exhausted_role_id': '666666666666666666',
  'verification.alert.failure_role_id': '777777777777777777',
  'verification.log.channel_id': SALON_LOG,
};

const TEXTES = {
  'verification.buttons.start': 'Se vérifier',
  'verification.buttons.enter_code': 'Entrer le code',
  'verification.modal.title': 'Vérification',
  'verification.modal.field_label': 'Code affiché sur l\'image',
  'verification.modal.placeholder': 'Les caractères, dans l\'ordre',
};

const fakeLogger = () => {
  const entries = [];
  const record = (level) => (message, context) => entries.push({ level, message, context });

  return {
    entries,
    error: record('error'),
    warn: record('warn'),
    info: record('info'),
    debug: record('debug'),
    forModule: () => fakeLoggerShared,
    of: (level) => entries.filter((entry) => entry.level === level),
  };
};

let fakeLoggerShared = null;

/** Contexte du noyau, tel que le routeur et le chargeur le composent. */
const fakeCtx = ({ salons = {}, capabilities = new CapabilityRegistry(), ordre = [] } = {}) => {
  fakeLoggerShared = fakeLogger();

  return {
    module: 'verification',
    ordre,
    logger: fakeLoggerShared,
    capabilities,
    config: {
      get: (path) => {
        if (!(path in REGLAGES)) throw new Error(`chemin inconnu : ${path}`);
        return REGLAGES[path];
      },
      text: (key) => TEXTES[key] ?? key,
    },
    // Le moteur d'embeds rend le nom du gabarit : chaque test nomme la réponse
    // attendue plutôt que de la deviner.
    embeds: { render: (template, variables = {}) => ({ template, variables }) },
    client: {
      channels: {
        fetch: async (id) => {
          if (!(id in salons)) throw new Error(`salon introuvable : ${id}`);
          return salons[id];
        },
      },
    },
  };
};

/**
 * Salon factice retenant ce qu'on y envoie.
 *
 * Le compteur d'identifiants est monotone et non lié à la taille de la table :
 * un message supprimé puis republié doit recevoir un identifiant NEUF, sinon le
 * test ne distinguerait pas une republication d'un message resté en place.
 */
const fakeChannel = (id, { messages = new Map(), ordre = null } = {}) => {
  let suivant = 0;

  return {
    id,
    envois: [],
    messages: {
      fetch: async (messageId) => {
        if (!messages.has(messageId)) throw new Error('Unknown Message');
        return messages.get(messageId);
      },
      /** Ce que fait Discord quand quelqu'un supprime le message. */
      remove: (messageId) => messages.delete(messageId),
    },
    async send(payload) {
      ordre?.push('envoi');
      suivant += 1;
      const message = { id: `msg-${suivant}`, channelId: id };
      messages.set(message.id, message);
      this.envois.push(payload);
      return message;
    },
  };
};

/** Interaction factice : retient l'ordre exact de ce qu'on lui demande. */
const fakeInteraction = ({ roles = [], input = '', ordre = [], grantFails = false } = {}) => ({
  ordre,
  user: { id: MEMBRE },
  member: {
    roles: {
      cache: new Map(roles.map((id) => [id, { id }])),
      add: async (roleId) => {
        ordre.push(`role:${roleId}`);
        if (grantFails) throw new Error('Missing Permissions');
      },
    },
  },
  fields: { getTextInputValue: (field) => (field === CODE_FIELD ? input : undefined) },
  replies: [],
  modals: [],
  deferred: false,
  async deferReply(options) {
    ordre.push('defer');
    this.deferred = true;
    this.deferOptions = options;
  },
  async editReply(payload) {
    ordre.push('edit');
    this.replies.push(payload);
  },
  async showModal(modal) {
    ordre.push('modal');
    this.modals.push(modal);
  },
});

/** Moteur factice : le vrai est déjà couvert, ici seul son contrat compte. */
const fakeEngine = (résultats = {}) => {
  const appels = [];

  return {
    appels,
    begin(args) {
      appels.push({ type: 'begin', args });
      return résultats.begin ?? { outcome: OUTCOMES.issued, attachment: Buffer.from('png'), reused: false };
    },
    async submit(args) {
      appels.push({ type: 'submit', args });

      // Le vrai moteur exécute l'action avant d'écrire : le faux l'exécute
      // aussi, sinon les tests d'ordre ne prouveraient rien.
      if (résultats.acceptera !== false) await args.onAccepted();

      return résultats.submit ?? { outcome: OUTCOMES.success };
    },
  };
};

const composants = (engine) => {
  const liste = createComponents({ engine: () => engine });

  return Object.fromEntries(liste.map((composant) => [composant.action, composant]));
};

const gabarit = (interaction) => interaction.replies.at(-1).embeds[0].template;

describe('déclaration des composants', () => {
  test('les trois actions sont déclarées et publiques', () => {
    const liste = createComponents({ engine: () => null });

    assert.deepEqual(liste.map((c) => c.action), [ACTIONS.start, ACTIONS.open, ACTIONS.submit]);

    // Un membre non vérifié ne porte aucun rôle : fermer par défaut rendrait
    // ces boutons muets pour exactement le public visé.
    for (const composant of liste) {
      assert.equal(composant.permission, 'public');
      assert.equal(composant.permission_key, undefined, 'jamais les deux à la fois');
    }
  });
});

describe('bouton « Se vérifier »', () => {
  test('défère puis édite, sans jamais ouvrir de modale', async () => {
    const ordre = [];
    const interaction = fakeInteraction({ ordre });
    const { start } = composants(fakeEngine());

    await start.execute(interaction, fakeCtx());

    // Le rendu de l'image est synchrone et la fenêtre initiale est de trois
    // secondes : l'accusé la porte à quinze minutes.
    assert.deepEqual(ordre, ['defer', 'edit']);
    assert.equal(interaction.modals.length, 0);
    assert.equal(interaction.deferOptions.flags, EPHEMERAL);
  });

  test('joint l\'image et le bouton d\'ouverture de la modale', async () => {
    const interaction = fakeInteraction();
    const { start } = composants(fakeEngine());

    await start.execute(interaction, fakeCtx());

    const reply = interaction.replies.at(-1);

    assert.equal(reply.embeds[0].template, 'verification_challenge');
    assert.equal(reply.files[0].name, 'captcha.png');
    assert.match(reply.embeds[0].image.url, /^attachment:\/\/captcha\.png$/);

    const bouton = reply.components[0].components[0].data;

    assert.deepEqual(decodeCustomId(bouton.custom_id), {
      module: 'verification',
      action: ACTIONS.open,
      args: [],
    });
  });

  test('transmet au moteur le port du rôle, seule information Discord', async () => {
    const engine = fakeEngine();
    const { start } = composants(engine);

    await start.execute(fakeInteraction({ roles: [ROLE] }), fakeCtx());
    await start.execute(fakeInteraction({ roles: [] }), fakeCtx());

    assert.deepEqual(engine.appels.map((appel) => appel.args.hasRole), [true, false]);
  });

  test('un membre bloqué reçoit son gabarit, sans image', async () => {
    const interaction = fakeInteraction();
    const { start } = composants(
      fakeEngine({ begin: { outcome: OUTCOMES.blocked, justBlocked: false } }),
    );

    await start.execute(interaction, fakeCtx());

    assert.equal(gabarit(interaction), 'verification_blocked');
    assert.equal(interaction.replies.at(-1).files, undefined);
  });

  test('un membre déjà vérifié reçoit son gabarit', async () => {
    const interaction = fakeInteraction({ roles: [ROLE] });
    const { start } = composants(fakeEngine({ begin: { outcome: OUTCOMES.already_verified } }));

    await start.execute(interaction, fakeCtx());

    assert.equal(gabarit(interaction), 'verification_already_verified');
  });
});

describe('bouton « Entrer le code »', () => {
  test('ouvre la modale en PREMIÈRE réponse, sans accusé préalable', async () => {
    // Discord refuse d'ouvrir une modale sur une interaction déjà accusée. Ce
    // test protège la contrainte de plateforme : un deferReply glissé ici
    // rendrait la modale impossible, et le parcours s'arrêterait là.
    const ordre = [];
    const interaction = fakeInteraction({ ordre });
    const { open } = composants(fakeEngine());

    await open.execute(interaction, fakeCtx());

    assert.deepEqual(ordre, ['modal']);
    assert.equal(interaction.deferred, false);
  });

  test('la modale route vers la soumission et porte le champ de saisie', async () => {
    const interaction = fakeInteraction();
    const { open } = composants(fakeEngine());

    await open.execute(interaction, fakeCtx());

    const modal = interaction.modals[0].data;
    const champ = interaction.modals[0].components[0].components[0].data;

    assert.deepEqual(decodeCustomId(modal.custom_id), {
      module: 'verification',
      action: ACTIONS.submit,
      args: [],
    });
    assert.equal(champ.custom_id, CODE_FIELD);
  });
});

describe('soumission du code', () => {
  const soumettre = async (résultats, options = {}) => {
    const ordre = [];
    const interaction = fakeInteraction({ ordre, input: 'ABC234', ...options });
    const salons = {
      [SALON_ALERTE]: fakeChannel(SALON_ALERTE),
      [SALON_LOG]: fakeChannel(SALON_LOG),
    };
    const ctx = fakeCtx({ salons, capabilities: options.capabilities });
    const engine = fakeEngine(résultats);

    await composants(engine).submit.execute(interaction, ctx);

    return { interaction, ordre, salons, engine, ctx };
  };

  test('les cinq résultats du moteur produisent chacun leur gabarit', async () => {
    const attendus = [
      [{ outcome: OUTCOMES.success }, 'verification_success'],
      [{ outcome: OUTCOMES.wrong, remaining: 3 }, 'verification_wrong_code'],
      [{ outcome: OUTCOMES.expired }, 'verification_expired'],
      [{ outcome: OUTCOMES.blocked, justBlocked: false }, 'verification_blocked'],
      [{ outcome: OUTCOMES.already_verified }, 'verification_already_verified'],
    ];

    for (const [résultat, attendu] of attendus) {
      const { interaction } = await soumettre({ submit: résultat });

      assert.equal(gabarit(interaction), attendu, JSON.stringify(résultat));
    }
  });

  test('le nombre de tentatives restantes est transmis au gabarit', async () => {
    const { interaction } = await soumettre({ submit: { outcome: OUTCOMES.wrong, remaining: 2 } });

    assert.deepEqual(interaction.replies.at(-1).embeds[0].variables, { remaining: 2 });
  });

  test('défère avant d\'appeler le moteur', async () => {
    const { ordre } = await soumettre({ submit: { outcome: OUTCOMES.expired } });

    assert.equal(ordre[0], 'defer');
  });

  test('le rôle est attribué AVANT que la réussite ne soit écrite', async () => {
    // Prouvé par l'ordre des appels, pas par l'état final : c'est l'ordre qui
    // empêche un membre de rester sans rôle et sans ligne d'état.
    const { ordre } = await soumettre({ submit: { outcome: OUTCOMES.success } });

    assert.deepEqual(ordre, ['defer', `role:${ROLE}`, 'edit']);
  });

  test('la saisie de la modale est transmise telle quelle au moteur', async () => {
    const { engine } = await soumettre({ submit: { outcome: OUTCOMES.expired } });

    // Aucune normalisation ici : la casse et les espaces appartiennent au
    // moteur, qui les règle depuis la configuration.
    assert.equal(engine.appels[0].args.input, 'ABC234');
  });
});

describe('échec d\'attribution du rôle', () => {
  const échouer = async () => {
    const ordre = [];
    const interaction = fakeInteraction({ ordre, input: 'ABC234', grantFails: true });
    const salons = { [SALON_ALERTE]: fakeChannel(SALON_ALERTE), [SALON_LOG]: fakeChannel(SALON_LOG) };
    const ctx = fakeCtx({ salons });

    // Le faux moteur laisse remonter l'échec de l'action, comme le vrai.
    const engine = {
      async submit(args) {
        await args.onAccepted();
        return { outcome: OUTCOMES.success };
      },
      begin: () => ({ outcome: OUTCOMES.issued, attachment: Buffer.from('png') }),
    };

    await composants(engine).submit.execute(interaction, ctx);

    return { interaction, salons };
  };

  test('le membre reçoit un message d\'erreur, pas une réussite', async () => {
    const { interaction } = await échouer();

    assert.equal(gabarit(interaction), 'verification_role_failed');
  });

  test('le staff d\'administration est alerté dans le salon d\'alerte', async () => {
    const { salons } = await échouer();
    const envoi = salons[SALON_ALERTE].envois.at(-1);

    assert.equal(envoi.embeds[0].template, 'verification_alert_role_failure');

    // La mention vit dans le contenu : dans un embed, elle n'aurait notifié
    // personne.
    assert.equal(envoi.content, '<@&777777777777777777>');
    assert.deepEqual(envoi.allowedMentions, { roles: ['777777777777777777'] });
  });

  test('rien n\'est journalisé comme une vérification réussie', async () => {
    const { salons } = await échouer();

    assert.equal(salons[SALON_LOG].envois.length, 0);
  });
});

describe('alertes et journal', () => {
  const soumettre = async (résultat, capabilities = new CapabilityRegistry()) => {
    const salons = { [SALON_ALERTE]: fakeChannel(SALON_ALERTE), [SALON_LOG]: fakeChannel(SALON_LOG) };
    const ctx = fakeCtx({ salons, capabilities });
    const interaction = fakeInteraction({ input: 'ABC234' });

    await composants(fakeEngine({ submit: résultat })).submit.execute(interaction, ctx);

    return { salons, interaction };
  };

  test('l\'épuisement des tentatives alerte, avec la mention dans le contenu', async () => {
    const { salons } = await soumettre({ outcome: OUTCOMES.blocked, justBlocked: true });
    const envoi = salons[SALON_ALERTE].envois.at(-1);

    assert.equal(envoi.embeds[0].template, 'verification_alert_exhausted');
    assert.equal(envoi.content, '<@&666666666666666666>');
    assert.deepEqual(envoi.allowedMentions, { roles: ['666666666666666666'] });
    assert.equal(envoi.embeds[0].variables.member, `<@${MEMBRE}>`);
  });

  test('un membre déjà bloqué qui reclique n\'alerte personne', async () => {
    // Sans le drapeau justBlocked, le rôle staff serait mentionné à chaque
    // clic, et l'alerte finirait coupée par ceux qui la portent.
    const { salons } = await soumettre({ outcome: OUTCOMES.blocked, justBlocked: false });

    assert.equal(salons[SALON_ALERTE].envois.length, 0);
  });

  test('une vérification réussie est journalisée sans mentionner personne', async () => {
    const { salons } = await soumettre({ outcome: OUTCOMES.success });
    const envoi = salons[SALON_LOG].envois.at(-1);

    assert.equal(envoi.embeds[0].template, 'verification_log_success');
    assert.equal(envoi.content, undefined);
    assert.deepEqual(envoi.allowedMentions, { parse: [] }, 'un salon d\'arrivées ne notifie pas');
  });

  test('un échec de saisie ne part jamais dans Discord', async () => {
    const { salons } = await soumettre({ outcome: OUTCOMES.wrong, remaining: 2 });

    assert.equal(salons[SALON_LOG].envois.length, 0);
    assert.equal(salons[SALON_ALERTE].envois.length, 0);
  });

  test('capacité d\'alerte éteinte : le membre entre quand même', async () => {
    const capabilities = new CapabilityRegistry();
    capabilities.declare('verification.alert.exhausted', { module: 'verification' });
    capabilities.disable('verification.alert.exhausted', 'salon introuvable');

    const { salons, interaction } = await soumettre(
      { outcome: OUTCOMES.blocked, justBlocked: true },
      capabilities,
    );

    assert.equal(salons[SALON_ALERTE].envois.length, 0, 'l\'alerte se tait');
    assert.equal(gabarit(interaction), 'verification_blocked', 'le membre est répondu quand même');
  });

  test('un salon d\'alerte injoignable ne fait pas échouer la vérification', async () => {
    // Le salon n'est pas dans la table : `fetch` lève, comme pour un salon
    // supprimé entre-temps.
    const ctx = fakeCtx({ salons: { [SALON_LOG]: fakeChannel(SALON_LOG) } });
    const interaction = fakeInteraction({ input: 'ABC234' });

    await assert.doesNotReject(() =>
      composants(fakeEngine({ submit: { outcome: OUTCOMES.blocked, justBlocked: true } }))
        .submit.execute(interaction, ctx),
    );

    assert.equal(gabarit(interaction), 'verification_blocked');
    assert.match(fakeLoggerShared.of('error').at(-1).message, /notification staff impossible/);
  });
});

describe('message d\'accueil', () => {
  /** Dépôt factice : seule la table du message compte ici. */
  const fakeRepository = () => {
    const lignes = new Map();

    return {
      appels: [],
      message: {
        find: (channelId) => lignes.get(channelId) ?? null,
        save(channelId, messageId) {
          lignes.set(channelId, { channel_id: channelId, message_id: messageId });
        },
      },
    };
  };

  const monter = ({ messages = new Map() } = {}) => {
    const repository = fakeRepository();
    useRepository(repository);

    const ordre = [];
    const channel = fakeChannel(SALON, { messages, ordre });
    const ctx = fakeCtx({ salons: { [SALON]: channel }, ordre });

    return { repository, channel, ctx, messages };
  };

  test('publie quand aucun identifiant n\'est en base', async () => {
    const { repository, channel, ctx } = monter();

    const result = await ensureWelcome(ctx);

    assert.equal(result.action, 'published');
    assert.equal(channel.envois.length, 1);
    assert.equal(repository.message.find(SALON).message_id, result.messageId);
  });

  test('le message porte le bouton de démarrage', async () => {
    const { channel, ctx } = monter();

    await ensureWelcome(ctx);

    const envoi = channel.envois[0];

    assert.equal(envoi.embeds[0].template, 'verification_welcome');

    const bouton = envoi.components[0].components[0].data;

    assert.deepEqual(decodeCustomId(bouton.custom_id), {
      module: 'verification',
      action: ACTIONS.start,
      args: [],
    });
    assert.equal(bouton.label, 'Se vérifier');
  });

  test('ne fait rien quand le message est toujours là', async () => {
    const messages = new Map();
    const { repository, channel, ctx } = monter({ messages });

    await ensureWelcome(ctx);
    const premier = repository.message.find(SALON).message_id;

    const result = await ensureWelcome(ctx);

    assert.equal(result.action, 'kept');
    assert.equal(channel.envois.length, 1, 'aucun second message');
    assert.equal(repository.message.find(SALON).message_id, premier);
  });

  test('republie quand le message a disparu', async () => {
    const messages = new Map();
    const { repository, channel, ctx } = monter({ messages });

    await ensureWelcome(ctx);
    const premier = repository.message.find(SALON).message_id;

    messages.clear();

    const result = await ensureWelcome(ctx);

    assert.equal(result.action, 'republished');
    assert.equal(channel.envois.length, 2);
    assert.notEqual(repository.message.find(SALON).message_id, premier);
  });

  test('deux appels simultanés ne publient qu\'un message', async () => {
    // `ready` et un `messageDelete` peuvent partir ensemble : sans verrou, le
    // salon se retrouverait avec deux messages d'accueil, exactement ce que le
    // stockage en base cherche à éviter.
    const { channel, ctx } = monter();

    const [a, b] = await Promise.all([ensureWelcome(ctx), ensureWelcome(ctx)]);

    assert.equal(channel.envois.length, 1);
    assert.equal(a.messageId, b.messageId);
  });
});

describe('écouteur de suppression', () => {
  const listener = moduleEvents.find((event) => event.name === 'messageDelete');

  const monter = () => {
    const lignes = new Map();
    const repository = {
      message: {
        find: (channelId) => lignes.get(channelId) ?? null,
        save: (channelId, messageId) =>
          lignes.set(channelId, { channel_id: channelId, message_id: messageId }),
      },
    };

    useRepository(repository);

    const channel = fakeChannel(SALON, { messages: new Map() });
    const ctx = fakeCtx({ salons: { [SALON]: channel } });

    return { repository, channel, ctx };
  };

  test('le nom de l\'événement est la valeur camelCase de discord.js', () => {
    assert.equal(listener.name, 'messageDelete');
  });

  test('republie quand le message d\'accueil est supprimé', async () => {
    const { repository, channel, ctx } = monter();

    await ensureWelcome(ctx);
    const publié = repository.message.find(SALON).message_id;

    channel.messages.remove(publié);
    await listener.execute(ctx, { id: publié, channelId: SALON });

    assert.equal(channel.envois.length, 2);
  });

  test('ignore un autre message du même salon', async () => {
    const { channel, ctx } = monter();

    await ensureWelcome(ctx);
    await listener.execute(ctx, { id: 'un-autre-message', channelId: SALON });

    assert.equal(channel.envois.length, 1);
  });

  test('ignore un message d\'un autre salon', async () => {
    const { repository, channel, ctx } = monter();

    await ensureWelcome(ctx);
    const publié = repository.message.find(SALON).message_id;

    await listener.execute(ctx, { id: publié, channelId: '999999999999999999' });

    assert.equal(channel.envois.length, 1);
  });

  test('fonctionne sur un événement partiel, sans contenu', async () => {
    // `messageDelete` arrive aussi pour des messages absents du cache : le
    // filtre porte sur les identifiants, jamais sur le contenu.
    const { repository, channel, ctx } = monter();

    await ensureWelcome(ctx);
    const publié = repository.message.find(SALON).message_id;

    // Rien d'autre que les deux identifiants : ni contenu, ni auteur, ni embeds.
    channel.messages.remove(publié);
    await listener.execute(ctx, { id: publié, channelId: SALON });

    assert.equal(channel.envois.length, 2);
  });

  test('la republication ne se rappelle pas elle-même', async () => {
    // L'identifiant est enregistré immédiatement : un événement portant
    // l'ancien ne correspond plus à ce que la base contient. Vrai par
    // construction — le test est ce qui le signalera si ça cesse de l'être.
    const { repository, channel, ctx } = monter();

    await ensureWelcome(ctx);
    const premier = repository.message.find(SALON).message_id;

    channel.messages.remove(premier);
    await listener.execute(ctx, { id: premier, channelId: SALON });

    // Le meme evenement rejoue : l'identifiant en base est desormais le neuf.
    await listener.execute(ctx, { id: premier, channelId: SALON });

    assert.equal(channel.envois.length, 2, 'la seconde suppression du même message ne fait rien');
  });
});
