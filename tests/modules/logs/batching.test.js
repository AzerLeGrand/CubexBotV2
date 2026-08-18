import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createEmbedEngine } from '../../../src/core/embeds/index.js';
import { EMBED_LIMITS } from '../../../src/core/embeds/limits.js';
import { createBatcher } from '../../../src/modules/logs/batching.js';

/**
 * Découpage d'un lot d'embeds en messages.
 *
 * Le budget cumulé est le plafond dangereux : au-delà, Discord rejette le
 * message ENTIER sans indiquer lequel déborde. Le lot ne serait pas tronqué, il
 * ne serait pas affiché du tout — alors que les lignes sont déjà en base.
 */

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

/**
 * Vrai moteur du socle, avec une configuration minimale.
 *
 * `fits()` vient de lui et n'est JAMAIS recalculé dans le batcher : deux mesures
 * divergeraient, et celle qui se tromperait serait celle qu'on ne teste pas
 * contre l'API.
 */
const build = ({ logger = fakeLogger() } = {}) => {
  const config = {
    colors: { brand: '#F60321', success: '#57F287', error: '#E67E22', info: '#5865F2' },
    footer: null,
    template: () => ({ color: 'info', description_key: 'x' }),
    text: () => '',
  };

  return { logger, batcher: createBatcher({ embeds: createEmbedEngine({ config, logger }), logger }) };
};

/** Embed d'une taille donnée, mesuré comme Discord le compte. */
const embed = (length) => ({ color: 0, description: 'x'.repeat(length) });

describe('plafond de nombre', () => {
  test('onze embeds produisent deux messages', () => {
    const { batcher } = build();

    const messages = batcher.splitBatch(Array.from({ length: 11 }, () => embed(10)));

    assert.equal(messages.length, 2);
    assert.equal(messages[0].length, EMBED_LIMITS.embeds);
    assert.equal(messages[1].length, 11 - EMBED_LIMITS.embeds);
  });

  test('exactement le plafond tient dans un seul message', () => {
    const { batcher } = build();

    const messages = batcher.splitBatch(
      Array.from({ length: EMBED_LIMITS.embeds }, () => embed(10)),
    );

    assert.equal(messages.length, 1);
  });

  test('la limite vient du socle, jamais d\'un littéral', () => {
    // `discord.js` ne l'expose sous aucune constante : sa place est avec les
    // autres limites de plateforme.
    assert.equal(typeof EMBED_LIMITS.embeds, 'number');
    assert.equal(EMBED_LIMITS.embeds > 0, true);
  });

  test('un lot vide ne produit aucun message', () => {
    const { batcher } = build();

    assert.deepEqual(batcher.splitBatch([]), []);
  });
});

describe('budget cumulé', () => {
  test('un lot dépassant le budget est coupé AVANT la limite de nombre', () => {
    // Quatre embeds de 2000 caractères font 8000, au-delà des 6000 du budget,
    // alors que quatre est très en deçà du plafond de nombre.
    const { batcher } = build();

    const messages = batcher.splitBatch(Array.from({ length: 4 }, () => embed(2000)));

    assert.equal(messages.length > 1, true, 'le budget a coupé avant le nombre');

    for (const batch of messages) {
      const total = batch.reduce((sum, held) => sum + held.description.length, 0);

      assert.equal(total <= EMBED_LIMITS.total, true, `lot de ${total} caractères`);
    }
  });

  test('chaque message produit tient dans le budget', () => {
    const { batcher } = build();

    const tailles = [500, 3000, 500, 2500, 1000, 4000, 200];
    const messages = batcher.splitBatch(tailles.map((taille) => embed(taille)));

    for (const batch of messages) {
      const total = batch.reduce((sum, held) => sum + held.description.length, 0);

      assert.equal(total <= EMBED_LIMITS.total, true, `lot de ${total} caractères`);
    }
  });

  test('aucun embed n\'est perdu ni dupliqué', () => {
    const { batcher } = build();

    const list = Array.from({ length: 25 }, (_, i) => embed(400 + i));
    const messages = batcher.splitBatch(list);

    assert.deepEqual(messages.flat(), list, 'l\'ordre et le compte sont préservés');
  });
});

describe('embed trop gros à lui seul', () => {
  test('part dans son propre message', () => {
    // Le moteur du socle a déjà tronqué ses textes aux limites de champ et l'a
    // journalisé : poser ici un second garde-fou concurrent ferait deux endroits
    // qui coupent et deux occasions de diverger.
    const { batcher } = build();

    const enorme = embed(EMBED_LIMITS.total + 1000);
    const messages = batcher.splitBatch([embed(100), enorme, embed(100)]);

    const seul = messages.find((batch) => batch.includes(enorme));

    assert.equal(seul.length, 1, 'il n\'entraîne personne avec lui');
    assert.equal(messages.flat().length, 3, 'et les autres passent quand même');
  });

  test('un lot d\'un seul embed trop gros produit un message', () => {
    const { batcher } = build();

    const messages = batcher.splitBatch([embed(EMBED_LIMITS.total + 1)]);

    assert.equal(messages.length, 1);
    assert.equal(messages[0].length, 1);
  });
});

describe('journalisation', () => {
  test('un découpage est signalé en debug', () => {
    const { batcher, logger } = build();

    batcher.splitBatch(Array.from({ length: 11 }, () => embed(10)));

    assert.equal(logger.of('debug').length, 1);
    assert.equal(logger.of('debug')[0].context.messages, 2);
  });

  test('un lot qui tient ne dit rien', () => {
    const { batcher, logger } = build();

    batcher.splitBatch([embed(10), embed(10)]);

    assert.deepEqual(logger.entries, []);
  });
});
