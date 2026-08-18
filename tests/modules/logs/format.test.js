import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { formatTime, INVALID_TIME } from '../../../src/modules/logs/format.js';
import { toIsoUtc } from '../../../src/modules/logs/time.js';

/**
 * Horodatage d'affichage.
 *
 * Première fois du projet que `bot.timezone` sert. Il ne doit jamais se
 * confondre avec `toIsoUtc()` du lot 2, réservé au stockage : une valeur
 * d'affichage repartie en base casserait l'ordre de la purge à chaque
 * changement d'heure.
 */

const PARIS = 'Europe/Paris';

/** Même INSTANT, de part et d'autre du changement d'heure. */
const ETE = '2026-07-15T12:00:00.000Z';
const HIVER = '2026-01-15T12:00:00.000Z';

describe('application du fuseau', () => {
  test('un même instant rend deux heures différentes en été et en hiver', () => {
    // La preuve que le fuseau est réellement appliqué : à midi UTC correspond
    // 14h à Paris l'été et 13h l'hiver. Une implémentation qui ignorerait le
    // fuseau rendrait la même valeur deux fois.
    const ete = formatTime(ETE, PARIS);
    const hiver = formatTime(HIVER, PARIS);

    assert.equal(ete, '14:00:00');
    assert.equal(hiver, '13:00:00');
    assert.notEqual(ete, hiver);
  });

  test('le même instant rend des heures différentes selon le fuseau', () => {
    assert.equal(formatTime(ETE, 'UTC'), '12:00:00');
    assert.equal(formatTime(ETE, PARIS), '14:00:00');
    assert.equal(formatTime(ETE, 'America/New_York'), '08:00:00');
  });

  test('minuit se lit 00, jamais 24', () => {
    // `hourCycle: h23` ferme cet écart : en h24, minuit se lirait « 24:00:00 »
    // et se classerait après 23h.
    assert.equal(formatTime('2026-07-15T22:00:00.000Z', PARIS), '00:00:00');
  });

  test('la forme est stable, deux chiffres partout', () => {
    assert.match(formatTime('2026-07-15T05:03:07.000Z', 'UTC'), /^\d{2}:\d{2}:\d{2}$/);
  });

  test('accepte ce que toIsoUtc écrit', () => {
    // Les deux fonctions se parlent : l'une écrit en base, l'autre relit pour
    // afficher. Un format qui ne se relirait pas serait invisible en tests
    // unitaires séparés.
    const at = new Date(Date.UTC(2026, 6, 15, 12, 0, 0, 0));

    assert.equal(formatTime(toIsoUtc(at), PARIS), '14:00:00');
  });
});

describe('entrée illisible', () => {
  test('rend un marqueur, jamais une exception', () => {
    // La ligne est déjà en base : un embed entier perdu pour une date serait une
    // punition disproportionnée.
    for (const value of ['pas une date', '', 'demain', null, undefined, 42]) {
      assert.doesNotThrow(() => formatTime(value, PARIS), `pour ${JSON.stringify(value)}`);
      assert.equal(formatTime(value, PARIS), INVALID_TIME, `pour ${JSON.stringify(value)}`);
    }
  });

  test('le marqueur est visible, jamais une chaîne vide', () => {
    // Un blanc passerait pour un oubli d'affichage et ne se remarquerait pas.
    assert.notEqual(INVALID_TIME, '');
    assert.equal(INVALID_TIME.length > 0, true);
  });

  test('un fuseau inconnu rend le marqueur plutôt que de lever', () => {
    // La validation du noyau vérifie le fuseau au démarrage, mais les données
    // ICU du VPS peuvent différer de celles du poste.
    assert.equal(formatTime(ETE, 'Mars/Olympus_Mons'), INVALID_TIME);
  });
});

describe('fuseau obligatoire', () => {
  test('lève quand il manque', () => {
    // Aucun repli sur le fuseau du système : il diffère entre le poste de
    // développement et le VPS, et le repli produirait des heures fausses sans
    // rien signaler.
    for (const value of [undefined, null, '', 0]) {
      assert.throws(() => formatTime(ETE, value), TypeError, `pour ${JSON.stringify(value)}`);
    }
  });

  test('le message nomme ce qui manque', () => {
    assert.throws(() => formatTime(ETE), /fuseau horaire obligatoire/);
  });
});

describe('portabilité', () => {
  test('ne dépend pas de la locale du processus', () => {
    // Une locale explicite plutôt que celle du système : le poste Windows et le
    // VPS Debian doivent produire la même chaîne. Un format nommé rendrait
    // « 4:32:07 PM » sur l'un et « 16:32:07 » sur l'autre.
    const avant = process.env.LANG;

    try {
      process.env.LANG = 'en_US.UTF-8';
      const anglais = formatTime(ETE, PARIS);

      process.env.LANG = 'fr_FR.UTF-8';
      const francais = formatTime(ETE, PARIS);

      assert.equal(anglais, francais);
      assert.equal(anglais, '14:00:00');
    } finally {
      if (avant === undefined) delete process.env.LANG;
      else process.env.LANG = avant;
    }
  });

  test('ne rend jamais de mention AM ou PM', () => {
    for (const heure of ['2026-07-15T01:00:00.000Z', '2026-07-15T20:00:00.000Z']) {
      assert.doesNotMatch(formatTime(heure, PARIS), /[AP]M/i);
    }
  });
});
