import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createEmbedEngine, EMBED_LIMITS } from '../../../src/core/embeds/index.js';
import { render } from '../../../src/utils/template.js';

const PALETTE = { brand: '#F60321', success: '#57F287', error: '#E67E22', info: '#5865F2' };

const TEMPLATES = {
  command_denied: {
    color: 'error',
    title_key: 'commands.denied.title',
    description_key: 'commands.denied.description',
  },
  sans_titre: { color: 'info', description_key: 'simple' },
  couleur_directe: { color: '#123456', description_key: 'simple' },
};

const TEXTS = {
  'commands.denied.title': 'Accès refusé',
  'commands.denied.description': 'Réservé à l\'équipe, {username}.',
  simple: 'Texte simple.',
  long: 'x'.repeat(5000),
};

/**
 * Configuration factice, qui reproduit le contrat réel : `text()` consomme le
 * `missing` du moteur de substitution et le journalise.
 */
const fakeConfig = (logger, { footer = { text: 'Cubex', timestamp: true } } = {}) => ({
  colors: PALETTE,
  footer,
  template: (name) => TEMPLATES[name],
  text: (key, variables) => {
    const value = TEXTS[key];
    if (value === undefined) return key;

    const { text, missing } = render(value, variables);
    if (missing.length > 0) logger.error('variables non fournies au gabarit', { key, missing });

    return text;
  },
});

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

const engine = (options) => {
  const logger = fakeLogger();
  return { logger, embeds: createEmbedEngine({ config: fakeConfig(logger, options), logger }) };
};

describe('render', () => {
  test('assemble titre, description, couleur et pied de page', () => {
    const { embeds } = engine();

    const embed = embeds.render('command_denied', { username: 'Azer' });

    assert.equal(embed.title, 'Accès refusé');
    assert.equal(embed.description, 'Réservé à l\'équipe, Azer.');
    assert.equal(embed.color, 0xe67e22);
    assert.equal(embed.footer.text, 'Cubex');
    assert.match(embed.timestamp, /^\d{4}-\d{2}-\d{2}T.+Z$/);
  });

  test('résout les quatre clés de la palette', () => {
    const { embeds } = engine();
    const attendu = { brand: 0xf60321, success: 0x57f287, error: 0xe67e22, info: 0x5865f2 };

    for (const [clé, valeur] of Object.entries(attendu)) {
      TEMPLATES.sans_titre.color = clé;
      assert.equal(embeds.render('sans_titre').color, valeur, `couleur ${clé}`);
    }

    TEMPLATES.sans_titre.color = 'info';
  });

  test('accepte une couleur hexadécimale directe', () => {
    const { embeds } = engine();

    assert.equal(embeds.render('couleur_directe').color, 0x123456);
  });

  test('se replie sur la marque et journalise une couleur inconnue', () => {
    const { embeds, logger } = engine();
    TEMPLATES.sans_titre.color = 'chartreuse';

    const embed = embeds.render('sans_titre');

    assert.equal(embed.color, 0xf60321);
    assert.match(logger.of('error')[0].message, /couleur absente/);

    TEMPLATES.sans_titre.color = 'info';
  });

  test('omet le titre quand le gabarit n\'en déclare pas', () => {
    const { embeds } = engine();

    assert.equal('title' in embeds.render('sans_titre'), false);
  });

  test('omet l\'horodatage quand le pied de page ne le demande pas', () => {
    const { embeds } = engine({ footer: { text: 'Cubex', timestamp: false } });

    const embed = embeds.render('sans_titre');

    assert.equal(embed.footer.text, 'Cubex');
    assert.equal('timestamp' in embed, false);
  });

  test('lève sur un gabarit absent : le nom vient du code, pas de la configuration', () => {
    const { embeds } = engine();

    assert.throws(() => embeds.render('inexistant'), /gabarit d'embed absent/);
  });

  test('journalise la variable non fournie et laisse son marqueur visible', () => {
    const { embeds, logger } = engine();

    const embed = embeds.render('command_denied');

    assert.match(embed.description, /\{username\}/);
    assert.deepEqual(logger.of('error')[0].context.missing, ['username']);
  });
});

describe('limites de plateforme', () => {
  test('tronque une description trop longue en le signalant', () => {
    const { embeds, logger } = engine();
    TEMPLATES.sans_titre.description_key = 'long';

    const embed = embeds.render('sans_titre');

    assert.equal(embed.description.length, EMBED_LIMITS.description);
    assert.match(embed.description, /…$/);
    assert.match(logger.of('warn')[0].message, /tronqué/);
    assert.equal(logger.of('warn')[0].context.field, 'description');

    TEMPLATES.sans_titre.description_key = 'simple';
  });

  test('mesure le budget cumulé d\'un message', () => {
    const { embeds } = engine();
    const embed = embeds.render('command_denied', { username: 'Azer' });

    const { ok, length } = embeds.fits([embed]);

    assert.equal(ok, true);
    assert.equal(
      length,
      embed.title.length + embed.description.length + embed.footer.text.length,
    );
  });

  test('refuse un ensemble dépassant le budget du message', () => {
    const { embeds } = engine();
    const gros = { description: 'x'.repeat(4000), footer: { text: 'Cubex' } };

    const { ok, length } = embeds.fits([gros, gros]);

    assert.equal(ok, false);
    assert.ok(length > EMBED_LIMITS.total);
  });

  test('MUETTE : elle mesure, elle n\'alerte pas', () => {
    // Une fonction ne peut pas être à la fois un prédicat consulté en boucle et
    // une alerte. Un appelant qui découpe un lot l'interroge une fois par
    // coupure : journaliser ici ferait émettre à un fonctionnement sain le
    // signal réservé aux anomalies, et noierait un vrai dépassement.
    //
    // C'est à l'appelant de dire ce que sa décision signifie — le découpage d'un
    // lot est une information de fonctionnement, donc un `debug`.
    const { embeds, logger } = engine();
    const gros = { description: 'x'.repeat(4000), footer: { text: 'Cubex' } };

    embeds.fits([gros, gros]);
    embeds.fits([gros]);

    assert.deepEqual(logger.entries, []);
  });

  test('compte les champs dans le budget', () => {
    const { embeds } = engine();
    const embed = { fields: [{ name: 'abc', value: 'defgh' }] };

    assert.equal(embeds.fits([embed]).length, 8);
  });
});
