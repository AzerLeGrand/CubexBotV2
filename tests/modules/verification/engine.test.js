import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { createDatabase } from '../../../src/core/database/index.js';
import { CORE_OWNER } from '../../../src/core/database/migrations.js';
import { createChallenge } from '../../../src/modules/verification/challenge/index.js';
import { HISTORY_EVENTS, OUTCOMES } from '../../../src/modules/verification/constants.js';
import { createVerificationEngine } from '../../../src/modules/verification/engine.js';
import { createVerificationRepository } from '../../../src/modules/verification/repository.js';
import { createChallengeStore } from '../../../src/modules/verification/store.js';
import { fromRoot } from '../../../src/utils/paths.js';

/**
 * Le moteur ne connaît pas Discord : aucun objet discord.js n'apparaît ici, et
 * `hasRole` arrive en argument.
 */

const MEMBRE = '123456789012345678';
const AUTRE = '987654321098765432';

const REGLAGES = {
  'verification.challenge.type': 'image',
  'verification.challenge.code_length': 6,
  'verification.challenge.ttl_seconds': 300,
  'verification.challenge.alphabet': 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
  'verification.challenge.sweep_interval_seconds': 60,
  'verification.challenge.input.case_sensitive': false,
  'verification.challenge.input.strip_whitespace': true,
  'verification.challenge.image.width': 320,
  'verification.challenge.image.height': 110,
  'verification.challenge.image.font_path': 'assets/fonts/DejaVuSans-Bold.ttf',
  'verification.challenge.image.font_size': 52,
  'verification.challenge.image.background': '#FFFFFF',
  'verification.challenge.image.text_color': '#1A1A1A',
  'verification.challenge.image.noise_lines': 6,
  'verification.challenge.image.noise_dots': 220,
  'verification.challenge.image.distortion': 0.35,
  'verification.challenge.image.slow_render_ms': 50,
  'verification.max_attempts': 5,
};

/** Configuration factice qui lève sur un chemin inconnu, comme la vraie. */
const fakeConfig = (overrides = {}) => {
  const values = { ...REGLAGES, ...overrides };

  return {
    values,
    get: (path) => {
      if (!(path in values)) throw new Error(`chemin de configuration inconnu : ${path}`);
      return values[path];
    },
  };
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
    of: (level) => entries.filter((entry) => entry.level === level),
  };
};

const SOURCES = [
  { owner: CORE_OWNER, directory: fromRoot('migrations') },
  { owner: 'verification', directory: fromRoot('src', 'modules', 'verification', 'migrations') },
];

/**
 * Horloge pilotée : la validité et le balayage se testent en avançant le temps,
 * jamais en attendant.
 */
const clock = (start = 1_700_000_000_000) => {
  let value = start;

  return { now: () => value, advance: (ms) => (value += ms) };
};

const sandbox = (t, { overrides = {} } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'cubex-engine-'));
  const logger = fakeLogger();
  const database = createDatabase({ file: join(root, 'test.sqlite'), logger });

  t.after(() => {
    database.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  database.migrate(SOURCES);

  const config = fakeConfig(overrides);
  const time = clock();

  const challenge = createChallenge({ config, logger });
  challenge.prepare();

  const store = createChallengeStore({ config, logger, now: time.now });
  const repository = createVerificationRepository({ database });
  const engine = createVerificationEngine({ config, challenge, store, repository });

  return { database, logger, config, time, challenge, store, repository, engine };
};

const events = (repository, userId) =>
  repository.history(userId).map((row) => row.event);

describe('génération du code', () => {
  test('respecte la longueur et l\'alphabet configurés', async (t) => {
    const { challenge, config } = sandbox(t);
    const alphabet = config.get('verification.challenge.alphabet');

    for (let i = 0; i < 50; i += 1) {
      const { secret } = challenge.issue();

      assert.equal(secret.length, 6);
      for (const character of secret) assert.ok(alphabet.includes(character), character);
    }
  });

  test('suit la longueur quand la configuration change', async (t) => {
    const { challenge } = sandbox(t, { overrides: { 'verification.challenge.code_length': 9 } });

    assert.equal(challenge.issue().secret.length, 9);
  });

  test('ne tire pas deux fois la même chose', async (t) => {
    const { challenge } = sandbox(t);
    const tirages = new Set();

    for (let i = 0; i < 60; i += 1) tirages.add(challenge.issue().secret);

    // Six caractères sur trente et un : une collision sur soixante tirages est
    // assez improbable pour qu'une répétition signale un aléa cassé.
    assert.equal(tirages.size, 60);
  });

  test('rend un PNG', async (t) => {
    const { challenge } = sandbox(t);
    const { attachment } = challenge.issue();

    // Signature PNG : 89 50 4E 47.
    assert.ok(Buffer.isBuffer(attachment));
    assert.deepEqual([...attachment.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  });
});

describe('la police', () => {
  test('un chemin erroné refuse le démarrage plutôt que de rendre une image vide', async (t) => {
    // registerFromPath ne lève pas : il rend null. Sans contrôle, le captcha
    // sortirait dans une police de repli, ou en carrés vides sur une Debian nue.
    const { logger } = sandbox(t);
    const config = fakeConfig({
      'verification.challenge.image.font_path': 'assets/fonts/inexistante.ttf',
    });

    const challenge = createChallenge({ config, logger });

    assert.throws(() => challenge.prepare(), /police du captcha introuvable/);
  });
});

describe('normalisation de la saisie', () => {
  test('ignore la casse et les espaces quand la configuration le dit', async (t) => {
    const { challenge } = sandbox(t);

    assert.equal(challenge.accepts('ABC234', 'abc234'), true);
    assert.equal(challenge.accepts('ABC234', ' ABC 234 '), true);
    assert.equal(challenge.accepts('ABC234', 'abc 234'), true);
    assert.equal(challenge.accepts('ABC234', 'ABC235'), false);
  });

  test('respecte la casse quand la bascule l\'exige', async (t) => {
    const { challenge } = sandbox(t, {
      overrides: { 'verification.challenge.input.case_sensitive': true },
    });

    assert.equal(challenge.accepts('ABC234', 'abc234'), false);
    assert.equal(challenge.accepts('ABC234', 'ABC234'), true);
  });

  test('conserve les espaces quand la bascule l\'exige', async (t) => {
    const { challenge } = sandbox(t, {
      overrides: { 'verification.challenge.input.strip_whitespace': false },
    });

    assert.equal(challenge.accepts('ABC234', 'ABC 234'), false);
  });

  test('traite une saisie absente sans lever', async (t) => {
    const { challenge } = sandbox(t);

    for (const value of [undefined, null, '']) {
      assert.equal(challenge.accepts('ABC234', value), false);
    }
  });
});

describe('begin — demande d\'épreuve', () => {
  test('rend une épreuve à un membre inconnu', async (t) => {
    const { engine } = sandbox(t);

    const result = engine.begin({ userId: MEMBRE, hasRole: false });

    assert.equal(result.outcome, OUTCOMES.issued);
    assert.equal(result.reused, false);
    assert.ok(Buffer.isBuffer(result.attachment));
  });

  test('un reclic pendant la validité ne recalcule rien', async (t) => {
    const { engine, time } = sandbox(t);

    const premier = engine.begin({ userId: MEMBRE, hasRole: false });
    time.advance(60_000);
    const second = engine.begin({ userId: MEMBRE, hasRole: false });

    // Identité de Buffer, et non égalité de contenu : deux rendus successifs du
    // même code produiraient des images différentes — le bruit est aléatoire —
    // mais surtout, l'identité prouve qu'aucun second rendu n'a eu lieu.
    assert.equal(second.attachment, premier.attachment);
    assert.equal(second.reused, true);
    assert.equal(second.expiresAt, premier.expiresAt, 'la validité ne se prolonge pas non plus');
  });

  test('après expiration, une nouvelle épreuve est tirée', async (t) => {
    const { engine, time } = sandbox(t);

    const premier = engine.begin({ userId: MEMBRE, hasRole: false });
    time.advance(300_001);
    const second = engine.begin({ userId: MEMBRE, hasRole: false });

    assert.notEqual(second.attachment, premier.attachment);
    assert.equal(second.reused, false);
  });

  test('refuse un membre déjà vérifié sans rien générer', async (t) => {
    const { engine, store } = sandbox(t);

    const result = engine.begin({ userId: MEMBRE, hasRole: true });

    assert.equal(result.outcome, OUTCOMES.already_verified);
    assert.equal(result.attachment, undefined);
    assert.equal(store.size, 0, 'aucune épreuve n\'a été rangée');
  });

  test('refuse un membre bloqué sans rien générer', async (t) => {
    const { engine, repository, store } = sandbox(t);

    repository.registerFailure(MEMBRE, 1);

    const result = engine.begin({ userId: MEMBRE, hasRole: false });

    assert.equal(result.outcome, OUTCOMES.blocked);
    assert.equal(result.justBlocked, false, 'il était déjà bloqué avant de cliquer');
    assert.equal(store.size, 0);
  });
});

describe('submit — soumission d\'un code', () => {
  /** Ouvre une épreuve et rend le secret, pour saisir juste ou faux à volonté. */
  const engage = (held, userId = MEMBRE) => {
    held.engine.begin({ userId, hasRole: false });

    return held.store.get(userId).secret;
  };

  test('un code correct réussit, supprime la ligne d\'état et journalise', async (t) => {
    const held = sandbox(t);
    const secret = engage(held);

    // Une ligne d'état existe : le membre a échoué une fois avant de réussir.
    held.repository.registerFailure(MEMBRE, 5);

    const result = await held.engine.submit({ userId: MEMBRE, hasRole: false, input: secret, onAccepted: async () => {} });

    assert.equal(result.outcome, OUTCOMES.success);
    assert.equal(held.repository.find(MEMBRE), null, 'la ligne est supprimée, pas remise à zéro');
    assert.deepEqual(events(held.repository, MEMBRE), [
      HISTORY_EVENTS.failure,
      HISTORY_EVENTS.success,
    ]);
    assert.equal(held.store.size, 0, 'l\'épreuve est retirée de la mémoire');
  });

  test('un code faux consomme une tentative et annonce le reste', async (t) => {
    const held = sandbox(t);
    engage(held);

    const result = await held.engine.submit({ userId: MEMBRE, hasRole: false, input: 'FAUXXX' });

    assert.equal(result.outcome, OUTCOMES.wrong);
    assert.equal(result.remaining, 4);
    assert.equal(held.repository.find(MEMBRE).attempts, 1);
    assert.deepEqual(events(held.repository, MEMBRE), [HISTORY_EVENTS.failure]);
  });

  test('l\'épreuve survit à un code faux : le membre relit la même image', async (t) => {
    const held = sandbox(t);
    const secret = engage(held);

    await held.engine.submit({ userId: MEMBRE, hasRole: false, input: 'FAUXXX' });

    assert.equal(held.store.get(MEMBRE).secret, secret);
  });

  test('un code expiré ne consomme aucune tentative', async (t) => {
    const held = sandbox(t);
    const secret = engage(held);

    held.time.advance(300_001);

    const result = await held.engine.submit({ userId: MEMBRE, hasRole: false, input: secret, onAccepted: async () => {} });

    assert.equal(result.outcome, OUTCOMES.expired);
    assert.equal(held.repository.find(MEMBRE), null, 'aucune ligne d\'état créée');
    assert.deepEqual(events(held.repository, MEMBRE), []);
  });

  test('un code absent de la mémoire ne consomme aucune tentative', async (t) => {
    // Le cas du redémarrage : le membre a son image sous les yeux, son code
    // n'existe plus. Ce n'est pas son erreur.
    const held = sandbox(t);

    const result = await held.engine.submit({ userId: MEMBRE, hasRole: false, input: 'ABC234' });

    assert.equal(result.outcome, OUTCOMES.expired);
    assert.equal(held.repository.find(MEMBRE), null);
  });

  test('un membre déjà vérifié est refusé sans consommer', async (t) => {
    const held = sandbox(t);
    engage(held);

    const result = await held.engine.submit({ userId: MEMBRE, hasRole: true, input: 'FAUXXX' });

    assert.equal(result.outcome, OUTCOMES.already_verified);
    assert.equal(held.repository.find(MEMBRE), null);
  });

  test('un membre bloqué est refusé sans consommer', async (t) => {
    const held = sandbox(t);
    engage(held);
    held.repository.registerFailure(MEMBRE, 1);

    const avant = held.repository.find(MEMBRE).attempts;
    const result = await held.engine.submit({ userId: MEMBRE, hasRole: false, input: 'FAUXXX' });

    assert.equal(result.outcome, OUTCOMES.blocked);
    assert.equal(result.justBlocked, false);
    assert.equal(held.repository.find(MEMBRE).attempts, avant, 'le compteur n\'a pas bougé');
  });

  test('l\'action fournie s\'exécute AVANT l\'écriture de la réussite', async (t) => {
    const held = sandbox(t);
    const secret = engage(held);
    const ordre = [];

    await held.engine.submit({
      userId: MEMBRE,
      hasRole: false,
      input: secret,
      onAccepted: async () => {
        // Au moment de l'appel, rien ne doit encore avoir été écrit ni retiré.
        ordre.push('action');
        ordre.push(held.store.get(MEMBRE) === null ? 'épreuve retirée' : 'épreuve intacte');
        ordre.push(held.repository.history(MEMBRE).length === 0 ? 'base intacte' : 'base écrite');
      },
    });

    ordre.push('retour');

    assert.deepEqual(ordre, ['action', 'épreuve intacte', 'base intacte', 'retour']);
  });

  test('une action en échec ne touche à rien : le code reste valable', async (t) => {
    const held = sandbox(t);
    const secret = engage(held);

    await assert.rejects(() =>
      held.engine.submit({
        userId: MEMBRE,
        hasRole: false,
        input: secret,
        onAccepted: async () => {
          throw new Error('attribution impossible');
        },
      }),
    );

    // Le membre reclique une fois le serveur réparé et retombe sur la même
    // image, sans qu'on la régénère : c'est ce qui se perdrait si `drop`
    // passait devant l'action.
    assert.equal(held.store.get(MEMBRE).secret, secret);
    assert.equal(held.repository.find(MEMBRE), null, 'aucune réussite écrite');
    assert.deepEqual(events(held.repository, MEMBRE), [], 'aucune tentative consommée non plus');
  });

  test('oublier l\'action lève plutôt que d\'écrire une réussite non méritée', async (t) => {
    const held = sandbox(t);
    const secret = engage(held);

    await assert.rejects(
      () => held.engine.submit({ userId: MEMBRE, hasRole: false, input: secret }),
      /« onAccepted » est requis/,
    );

    assert.equal(held.repository.find(MEMBRE), null);
  });

  test('une écriture en échec après l\'action laisse le membre vérifié', async (t) => {
    // Cas inverse : l'action réussit, l'écriture échoue. Le membre a son rôle,
    // la ligne d'état survit — sans conséquence, puisque `hasRole` le fera
    // répondre « déjà vérifié » au clic suivant. Vérifié plutôt que supposé.
    const held = sandbox(t);
    const secret = engage(held);

    held.database.exec('DROP TABLE verification_history');

    await assert.rejects(() =>
      held.engine.submit({
        userId: MEMBRE,
        hasRole: false,
        input: secret,
        onAccepted: async () => {},
      }),
    );

    const apres = await held.engine.submit({ userId: MEMBRE, hasRole: true, input: secret });

    assert.equal(apres.outcome, OUTCOMES.already_verified);
  });

  test('la casse et les espaces n\'empêchent pas de réussir', async (t) => {
    const held = sandbox(t);
    const secret = engage(held);

    const result = await held.engine.submit({
      userId: MEMBRE,
      hasRole: false,
      input: ` ${secret.toLowerCase()} `,
      onAccepted: async () => {},
    });

    assert.equal(result.outcome, OUTCOMES.success);
  });
});

describe('blocage', () => {
  const echouer = async (held, fois) => {
    let result = null;

    for (let i = 0; i < fois; i += 1) {
      held.engine.begin({ userId: MEMBRE, hasRole: false });
      result = await held.engine.submit({ userId: MEMBRE, hasRole: false, input: 'FAUXXX' });
    }

    return result;
  };

  test('le seuil atteint pose le blocage et le signale comme nouveau', async (t) => {
    const held = sandbox(t);

    const result = await echouer(held, 5);

    assert.equal(result.outcome, OUTCOMES.blocked);
    assert.equal(result.justBlocked, true, 'sans ce drapeau, l\'alerte partirait à chaque clic');

    const state = held.repository.find(MEMBRE);

    assert.equal(state.attempts, 5);
    assert.notEqual(state.blocked_at, null);
    assert.match(state.blocked_at, /^\d{4}-\d{2}-\d{2}T/, 'ISO 8601 strict, avec le T');
  });

  test('l\'historique porte les cinq échecs puis le blocage', async (t) => {
    const held = sandbox(t);

    await echouer(held, 5);

    assert.deepEqual(events(held.repository, MEMBRE), [
      ...Array.from({ length: 5 }, () => HISTORY_EVENTS.failure),
      HISTORY_EVENTS.block,
    ]);
  });

  test('l\'épreuve est retirée de la mémoire au blocage', async (t) => {
    const held = sandbox(t);

    await echouer(held, 5);

    assert.equal(held.store.size, 0);
  });

  test('le compte des tentatives restantes décroît jusqu\'au blocage', async (t) => {
    const held = sandbox(t);
    const restes = [];

    for (let i = 0; i < 4; i += 1) {
      held.engine.begin({ userId: MEMBRE, hasRole: false });
      restes.push((await held.engine.submit({ userId: MEMBRE, hasRole: false, input: 'FAUXXX' })).remaining);
    }

    assert.deepEqual(restes, [4, 3, 2, 1]);
  });

  test('l\'incrément et le blocage sont dans la même transaction', async (t) => {
    const held = sandbox(t);

    held.engine.begin({ userId: MEMBRE, hasRole: false });
    await held.engine.submit({ userId: MEMBRE, hasRole: false, input: 'FAUXXX' });

    const avant = held.repository.find(MEMBRE).attempts;

    // L'écriture de l'historique échouera : sans transaction, le compteur
    // aurait avancé et le blocage aurait pu être posé sans sa trace. Un arrêt
    // entre les deux laisserait un membre à cinq sur cinq et jamais bloqué,
    // donc en tentatives illimitées.
    held.database.exec('DROP TABLE verification_history');

    await assert.rejects(() =>
      held.engine.submit({ userId: MEMBRE, hasRole: false, input: 'FAUXXX' }),
    );

    const apres = held.repository.find(MEMBRE);

    assert.equal(apres.attempts, avant, 'le compteur n\'a pas bougé');
    assert.equal(apres.blocked_at, null, 'aucun blocage posé');
  });

  test('un blocage ne suit pas un autre membre', async (t) => {
    const held = sandbox(t);

    await echouer(held, 5);

    assert.equal(held.repository.isBlocked(AUTRE), false);
    assert.equal(held.engine.begin({ userId: AUTRE, hasRole: false }).outcome, OUTCOMES.issued);
  });

  test('le déblocage supprime la ligne et garde l\'auteur en historique', async (t) => {
    const held = sandbox(t);

    await echouer(held, 5);

    const { changed, wasBlocked } = held.repository.registerUnblock(MEMBRE, AUTRE);

    assert.deepEqual({ changed, wasBlocked }, { changed: true, wasBlocked: true });

    // La ligne est SUPPRIMÉE, pas remise à zéro : cette table ne contient que
    // les vérifications en cours et les blocages actifs, et une ligne à zéro
    // sans blocage n'est ni l'un ni l'autre — elle s'accumulerait à chaque
    // déblocage. L'absence de ligne se lit comme un compteur à zéro.
    assert.equal(held.repository.find(MEMBRE), null);
    assert.equal(held.repository.isBlocked(MEMBRE), false);

    const derniere = held.repository.history(MEMBRE).at(-1);

    assert.equal(derniere.event, HISTORY_EVENTS.unblock);
    assert.equal(derniere.actor_id, AUTRE);
  });

  test('un déblocage sans effet n\'écrit rien', async (t) => {
    const held = sandbox(t);

    const résultat = held.repository.registerUnblock(MEMBRE, AUTRE);

    // Une commande sans effet n'est pas une action : l'inscrire polluerait un
    // historique qui sert justement à retrouver ce qui s'est passé.
    assert.deepEqual(résultat, { changed: false, wasBlocked: false });
    assert.deepEqual(events(held.repository, MEMBRE), []);
  });
});

describe('mémoire des épreuves', () => {
  test('le balayage retire les entrées échues et laisse les autres', async (t) => {
    const { store, time } = sandbox(t);

    store.put(MEMBRE, { secret: 'ABC234', attachment: Buffer.alloc(1) });
    time.advance(200_000);
    store.put(AUTRE, { secret: 'DEF567', attachment: Buffer.alloc(1) });

    // MEMBRE est à 200 s de vie, AUTRE à 0 : franchir 300 s n'échoit que le premier.
    time.advance(150_000);

    assert.equal(store.sweep(), 1);
    assert.equal(store.size, 1);
    assert.equal(store.get(MEMBRE), null);
    assert.notEqual(store.get(AUTRE), null);
  });

  test('le minuteur ne retient pas le processus et s\'annule à l\'arrêt', async (t) => {
    const { config, logger } = sandbox(t);
    const fermetures = [];

    const shutdown = {
      register: (nom, close, options) => fermetures.push({ nom, close, options }),
    };

    const store = createChallengeStore({ config, logger, shutdown }).start();

    // unref() couvre le cas normal ; l'inscription à la séquence d'arrêt couvre
    // le minuteur armé pendant la fermeture, qui la ferait échouer.
    assert.equal(fermetures.length, 1);
    assert.equal(fermetures[0].nom, 'verification-challenges');
    assert.equal(fermetures[0].options.timeoutMs, 1_000);

    fermetures[0].close();

    // Rien ne reste armé : un second stop() est sans effet, et le processus
    // n'est retenu par personne.
    assert.doesNotThrow(() => store.stop());
  });

  test('l\'entrée échue disparaît à la lecture, sans attendre le balayage', async (t) => {
    const { store, time } = sandbox(t);

    store.put(MEMBRE, { secret: 'ABC234', attachment: Buffer.alloc(1) });
    time.advance(300_001);

    assert.equal(store.get(MEMBRE), null);
    assert.equal(store.size, 0, 'retirée au passage, la validité ne dépend pas du balayage');
  });
});

describe('rendu lent', () => {
  test('un rendu au-delà du seuil est journalisé', async (t) => {
    // Seuil à zéro : tout rendu le dépasse. C'est la seule façon de découvrir
    // qu'une machine est un ordre de grandeur plus lente avant que des
    // interactions n'expirent sous les yeux des membres.
    const { challenge, logger } = sandbox(t, {
      overrides: { 'verification.challenge.image.slow_render_ms': 0 },
    });

    challenge.issue();

    const entree = logger.of('warn').at(-1);

    assert.match(entree.message, /rendu du captcha lent/);
    assert.equal(entree.context.limit_ms, 0);
    assert.equal(typeof entree.context.elapsed_ms, 'number');
  });

  test('un rendu normal ne dit rien', async (t) => {
    const { challenge, logger } = sandbox(t);

    challenge.issue();

    assert.equal(logger.of('warn').length, 0);
  });
});

describe('message permanent', () => {
  test('enregistre et relit l\'identifiant par salon', async (t) => {
    const { repository } = sandbox(t);

    assert.equal(repository.message.find('111'), null);

    repository.message.save('111', '222');
    assert.equal(repository.message.find('111').message_id, '222');

    // Republication dans le même salon : la ligne est mise à jour, pas doublée.
    repository.message.save('111', '333');
    assert.equal(repository.message.find('111').message_id, '333');

    // Un autre salon ne l'écrase pas : l'ancienne ligne devient inerte.
    repository.message.save('444', '555');
    assert.equal(repository.message.find('111').message_id, '333');
  });
});
