import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { crossReference } from '../../../src/core/config/crossref.js';
import { ConfigError, formatErrors, formatErrorsWithin } from '../../../src/core/config/errors.js';
import { detectSecrets } from '../../../src/core/config/secrets.js';
import { validate } from '../../../src/core/config/validate.js';

const ID = '123456789012345678';

const CONFIG = {
  bot: { guild_id: ID, timezone: 'Europe/Paris' },
  commands: { reload: { allowed_roles: [ID] } },
  database: { file: 'data/cubex.sqlite' },
  logging: { level: 'info', directory: 'logs', file_prefix: 'cubex', retention_days: 30 },
  purge: { hour: 4 },
  minecraft: { enabled: false },
};

const MESSAGES = {
  commands: { denied: { title: 'Accès refusé', description: 'Réservé à l\'équipe.' } },
};

const EMBEDS = {
  colors: { brand: '#F60321', success: '#57F287', error: '#E67E22', info: '#5865F2' },
  footer: { text: 'Cubex', timestamp: true },
  templates: {
    command_denied: {
      color: 'error',
      title_key: 'commands.denied.title',
      description_key: 'commands.denied.description',
    },
  },
};

const files = (overrides = {}) => ({
  config: CONFIG,
  messages: MESSAGES,
  embeds: EMBEDS,
  ...overrides,
});

describe('detectSecrets', () => {
  test('refuse un nom de clé évoquant un secret', () => {
    for (const key of ['token', 'password', 'secret', 'api_key', 'apikey', 'apiKey', 'bot_token']) {
      const errors = detectSecrets(files({ config: { ...CONFIG, [key]: 'valeur' } }));

      assert.equal(errors.length, 1, `la clé ${key} aurait dû être refusée`);
      assert.match(errors[0].hint, /\.env/);
    }
  });

  test('ne cherche pas les mots-clés dans les valeurs', () => {
    // tech_logs.redaction.patterns, phase 6 : la configuration du masquage de
    // secrets contient par construction ces mots-là.
    const config = {
      ...CONFIG,
      tech_logs: { redaction: { patterns: ['token', 'password=\\S+', 'api_key'] } },
    };

    assert.deepEqual(detectSecrets(files({ config })), []);
  });

  test('refuse une valeur ayant la forme d\'un jeton', () => {
    const jetons = {
      discord: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.abcdefghijklmnopqrstuvwxyz1234',
      openai: 'sk-abcdefghijklmnopqrstuvwxyz1234567890',
      github: 'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      aws: 'AKIAIOSFODNN7EXAMPLE',
    };

    for (const [nom, valeur] of Object.entries(jetons)) {
      const errors = detectSecrets(files({ config: { ...CONFIG, reglage: valeur } }));

      assert.equal(errors.length, 1, `le jeton ${nom} aurait dû être détecté`);
      assert.match(errors[0].message, /forme d'un secret/);
    }
  });

  test('ne cite jamais la valeur détectée', () => {
    const jeton = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';
    const [error] = detectSecrets(files({ config: { ...CONFIG, reglage: jeton } }));

    assert.ok(!error.message.includes(jeton));
    assert.ok(!error.hint.includes(jeton));
  });

  test('descend dans les tableaux et donne le chemin complet', () => {
    const config = { ...CONFIG, listes: [{ api_key: 'x' }] };
    const [error] = detectSecrets(files({ config }));

    assert.equal(error.key, 'listes.0.api_key');
  });

  test('laisse passer une configuration saine', () => {
    assert.deepEqual(detectSecrets(files()), []);
  });
});

describe('crossReference', () => {
  test('accepte des renvois qui résolvent', () => {
    assert.deepEqual(crossReference(files()), []);
  });

  test('refuse un *_key qui ne résout pas', () => {
    const embeds = {
      ...EMBEDS,
      templates: { t: { color: 'info', description_key: 'commands.absent' } },
    };
    const [error] = crossReference(files({ embeds }));

    assert.equal(error.file, 'embeds.yml');
    assert.match(error.message, /texte inexistant/);
    assert.match(error.hint, /messages\.yml/);
  });

  test('refuse un *_key qui désigne un ensemble de clés', () => {
    const embeds = {
      ...EMBEDS,
      templates: { t: { color: 'info', description_key: 'commands.denied' } },
    };
    const [error] = crossReference(files({ embeds }));

    assert.match(error.message, /pas un texte/);
  });

  test('vérifie aussi les *_key de config.yml', () => {
    const config = { ...CONFIG, tickets: { categories: [{ name_key: 'commands.absent' }] } };
    const [error] = crossReference(files({ config }));

    assert.equal(error.file, 'config.yml');
    assert.equal(error.key, 'tickets.categories.0.name_key');
  });

  test('ne signale pas les textes inutilisés de messages.yml', () => {
    const messages = { ...MESSAGES, orphelin: 'texte que rien n\'utilise encore' };

    assert.deepEqual(crossReference(files({ messages })), []);
  });

  test('abandonne quand messages.yml n\'a pas pu être lu', () => {
    // Le chargeur a déjà signalé le fichier ; déclarer introuvables toutes les
    // clés noierait l'anomalie réelle.
    assert.deepEqual(crossReference(files({ messages: null })), []);
  });

  test('refuse une couleur absente de la palette', () => {
    const embeds = {
      ...EMBEDS,
      templates: { t: { color: 'warning', description_key: 'commands.denied.title' } },
    };
    const [error] = crossReference(files({ embeds }));

    assert.match(error.message, /absente de la palette/);
    assert.match(error.hint, /brand, success, error, info/);
  });

  test('accepte une couleur hexadécimale hors palette', () => {
    const embeds = {
      ...EMBEDS,
      templates: { t: { color: '#123456', description_key: 'commands.denied.title' } },
    };

    assert.deepEqual(crossReference(files({ embeds })), []);
  });
});

describe('validate', () => {
  test('accepte une configuration saine et retourne les données', () => {
    const { data, errors, warnings } = validate(files());

    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.equal(data.config.bot.guild_id, ID);
    assert.equal(data.embeds.colors.brand, '#F60321');
  });

  test('n\'exécute aucun court-circuit : les trois passes remontent ensemble', () => {
    const result = validate(
      files({
        // secret + schéma invalide dans le même fichier
        config: {
          ...CONFIG,
          api_key: 'x',
          bot: { guild_id: 123456789012345678, timezone: 'Europe/Paris' },
        },
        // renvoi mort
        embeds: {
          ...EMBEDS,
          templates: { t: { color: 'info', description_key: 'commands.absent' } },
        },
      }),
    );

    const natures = {
      secret: result.errors.some((e) => /secret/.test(e.message)),
      schema: result.errors.some((e) => /sans guillemets/.test(e.message)),
      crossref: result.errors.some((e) => /texte inexistant/.test(e.message)),
    };

    assert.deepEqual(natures, { secret: true, schema: true, crossref: true });
    assert.equal(result.data, null);
  });

  test('la passe croisée tourne même quand le schéma a échoué', () => {
    const result = validate(
      files({
        config: { bot: { guild_id: ID } }, // sections manquantes
        embeds: {
          ...EMBEDS,
          templates: { t: { color: 'info', description_key: 'commands.absent' } },
        },
      }),
    );

    assert.ok(result.errors.some((e) => /texte inexistant/.test(e.message)));
  });

  test('la passe de schéma saute un fichier nul sans produire d\'erreur', () => {
    const { data, errors } = validate(files({ messages: null }));

    // Le chargeur a déjà signalé le fichier ; le répéter sous une autre forme
    // n'aiderait personne.
    assert.deepEqual(errors, []);

    // Conséquence à ne pas perdre de vue dans index.js : `data` non nul ne
    // signifie pas « configuration complète », mais « rien à redire sur ce qui
    // a pu être lu ». C'est l'appelant qui concatène les erreurs du chargeur.
    assert.notEqual(data, null);
    assert.equal(data.messages, null);
    assert.notEqual(data.config, null);
  });

  test('traduit une clé inconnue en la nommant', () => {
    const { errors } = validate(files({ config: { ...CONFIG, bot: { ...CONFIG.bot, salon: ID } } }));

    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /clé inconnue/);
    assert.equal(errors[0].key, 'bot.salon');
  });

  test('signale une section orpheline en avertissement, pas en erreur', () => {
    const { data, errors, warnings } = validate(files({ config: { ...CONFIG, tickets: {} } }));

    assert.deepEqual(errors, []);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].key, 'tickets');
    assert.notEqual(data, null);
  });
});

describe('formatErrorsWithin', () => {
  const make = (count) =>
    Array.from(
      { length: count },
      (_, i) => new ConfigError({ file: 'config.yml', path: [`cle${i}`], message: 'anomalie' }),
    );

  test('rend toutes les anomalies quand le budget le permet', () => {
    const { text, shown, total, truncated } = formatErrorsWithin(make(3), 4096);

    assert.equal(shown, 3);
    assert.equal(total, 3);
    assert.equal(truncated, false);
    assert.equal(text.split('\n').length, 3);
  });

  test('tronque sans dépasser le budget et retourne le compte total', () => {
    const { text, shown, total, truncated } = formatErrorsWithin(make(40), 200);

    assert.ok(text.length <= 200, `${text.length} caractères pour un budget de 200`);
    assert.equal(total, 40);
    assert.ok(shown < 40);
    assert.equal(truncated, true);
  });

  test('coupe des lignes entières, jamais au milieu d\'une anomalie', () => {
    const { text, shown } = formatErrorsWithin(make(40), 200);

    assert.equal(text.split('\n').length, shown);
    for (const line of text.split('\n')) assert.match(line, /anomalie$/);
  });

  test('montre une anomalie coupée plutôt que rien quand le budget est minuscule', () => {
    const { text, shown, truncated } = formatErrorsWithin(make(5), 20);

    assert.equal(text.length, 20);
    assert.match(text, /…$/);
    assert.equal(shown, 0);
    assert.equal(truncated, true);
  });

  test('ne produit aucune phrase de troncature : l\'enveloppe vient de messages.yml', () => {
    const { text } = formatErrorsWithin(make(40), 200);

    assert.doesNotMatch(text, /autres|affichées|tronqu/i);
  });

  // Le budget est la limite de la destination MOINS l'enveloppe déjà rendue.
  const LIMITE = 300;
  const ENVELOPPE = 'La configuration en place reste active.\n\n{errors}';

  test('le message final tient dans la limite quand le budget en déduit l\'enveloppe', () => {
    const rendue = ENVELOPPE.replace('{errors}', '');

    const { text } = formatErrorsWithin(make(40), LIMITE - rendue.length);
    const final = ENVELOPPE.replace('{errors}', text);

    assert.ok(final.length <= LIMITE, `${final.length} caractères pour une limite de ${LIMITE}`);
  });

  test('lui passer la limite entière fait déborder de la longueur de l\'enveloppe', () => {
    // Fige le piège : la troncature ne peut pas deviner ce qui l'entoure.
    const { text } = formatErrorsWithin(make(40), LIMITE);
    const final = ENVELOPPE.replace('{errors}', text);

    assert.ok(final.length > LIMITE);
  });
});

describe('formatErrors', () => {
  test('rend la localisation, le message et le conseil', () => {
    const rendu = formatErrors([
      new ConfigError({
        file: 'config.yml',
        path: ['bot', 'guild_id'],
        message: 'anomalie',
        hint: 'conseil',
      }),
    ]);

    assert.match(rendu, /1 erreur/);
    assert.match(rendu, /config\.yml → bot\.guild_id/);
    assert.match(rendu, /→ conseil/);
  });

  test('accorde le pluriel', () => {
    const deux = [
      new ConfigError({ file: 'a.yml', message: 'x' }),
      new ConfigError({ file: 'b.yml', message: 'y' }),
    ];

    assert.match(formatErrors(deux), /2 erreurs/);
  });
});
