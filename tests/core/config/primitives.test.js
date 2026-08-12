import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import {
  allowedRoles,
  color,
  duration,
  messageKey,
  PUBLIC,
  snowflake,
} from '../../../src/core/config/schema/primitives.js';

/** Première erreur d'une validation qui doit échouer. */
const failure = (schema, value) => {
  const result = schema.safeParse(value);
  assert.equal(result.success, false, `la valeur ${JSON.stringify(value)} aurait dû être refusée`);
  return result.error.issues[0];
};

const accepts = (schema, value) => {
  const result = schema.safeParse(value);
  assert.equal(result.success, true, result.error?.issues[0]?.message);
  return result.data;
};

describe('snowflake', () => {
  test('accepte 17, 18, 19 et 20 chiffres', () => {
    for (const length of [17, 18, 19, 20]) {
      const id = '1'.repeat(length);
      assert.equal(accepts(snowflake(), id), id);
    }
  });

  test('refuse un identifiant écrit sans guillemets et réclame les guillemets', () => {
    const issue = failure(snowflake(), 1234567890123456789);

    assert.match(issue.message, /sans guillemets/);
    assert.match(issue.message, /entourer la valeur de guillemets/);
  });

  test('ne cite jamais la valeur reçue, que js-yaml a déjà corrompue', () => {
    const corrupted = 1234567890123456789;
    const issue = failure(snowflake(), corrupted);

    // 1234567890123456800 : ce nombre ne figure dans aucun fichier, l'afficher
    // enverrait chercher l'erreur au mauvais endroit.
    assert.doesNotMatch(issue.message, /\d{16,}/);
    assert.ok(!issue.message.includes(String(corrupted)));
  });

  test('refuse une chaîne de 12 chiffres', () => {
    const issue = failure(snowflake(), '123456789012');

    assert.match(issue.message, /17 à 20 chiffres/);
  });

  test('refuse une chaîne de 25 chiffres', () => {
    const issue = failure(snowflake(), '1'.repeat(25));

    assert.match(issue.message, /17 à 20 chiffres/);
  });

  test('refuse un identifiant entouré d\'espaces sans le rattraper', () => {
    const issue = failure(snowflake(), ' 123456789012345678 ');

    assert.match(issue.message, /sans espace/);
  });

  test('refuse une valeur absente, nulle ou booléenne', () => {
    for (const value of [undefined, null, true]) {
      assert.match(failure(snowflake(), value).message, /chaîne de 17 à 20 chiffres/);
    }
  });

  test('donne le chemin complet d\'un identifiant imbriqué dans un tableau', () => {
    const schema = z.object({
      tickets: z.object({
        categories: z.array(z.object({ ping_role_ids: z.array(snowflake()) })),
      }),
    });

    const issue = failure(schema, {
      tickets: { categories: [{ ping_role_ids: ['123456789012345678', 1234567890123456789] }] },
    });

    assert.deepEqual(issue.path, ['tickets', 'categories', 0, 'ping_role_ids', 1]);
    assert.equal(issue.path.join('.'), 'tickets.categories.0.ping_role_ids.1');
  });

  test('ne convertit jamais un nombre en chaîne', () => {
    // Garde-fou contre une réintroduction de z.coerce.string() ou de .transform().
    assert.equal(snowflake().safeParse(123456789012345678).success, false);
  });
});

describe('allowedRoles', () => {
  test('accepte une liste non vide d\'identifiants', () => {
    const roles = ['123456789012345678', '987654321098765432'];

    assert.deepEqual(accepts(allowedRoles(), roles), roles);
  });

  test('accepte le littéral public', () => {
    assert.equal(accepts(allowedRoles(), PUBLIC), 'public');
  });

  test('refuse la liste vide en nommant le littéral public', () => {
    const issue = failure(allowedRoles(), []);

    assert.match(issue.message, /"public"/);
    assert.match(issue.message, /vide/);
  });

  test('refuse un identifiant invalide au sein de la liste', () => {
    assert.equal(allowedRoles().safeParse(['123']).success, false);
  });

  test('refuse toute autre valeur en nommant le littéral public', () => {
    for (const value of ['tous', true, 42, {}]) {
      assert.match(failure(allowedRoles(), value).message, /"public"/);
    }
  });
});

describe('duration', () => {
  test('accepte un entier strictement positif', () => {
    assert.equal(accepts(duration(), 90), 90);
  });

  test('refuse zéro, qui purgerait tout l\'historique dès la première nuit', () => {
    assert.match(failure(duration(), 0).message, /strictement positif/);
  });

  test('refuse une valeur négative ou décimale', () => {
    for (const value of [-1, 1.5]) {
      assert.match(failure(duration(), value).message, /entier strictement positif/);
    }
  });

  test('refuse une durée écrite en chaîne', () => {
    assert.equal(duration().safeParse('90').success, false);
  });
});

describe('color', () => {
  test('accepte les quatre clés de la palette', () => {
    for (const key of ['brand', 'success', 'error', 'info']) {
      assert.equal(accepts(color(), key), key);
    }
  });

  test('accepte un hexadécimal à six chiffres', () => {
    assert.equal(accepts(color(), '#F60321'), '#F60321');
  });

  test('refuse un hexadécimal à trois chiffres ou sans dièse', () => {
    for (const value of ['#FFF', 'F60321', '#F60321FF']) {
      assert.match(failure(color(), value).message, /hexadécimal/);
    }
  });

  test('refuse une clé de palette en majuscules', () => {
    assert.equal(color().safeParse('Brand').success, false);
  });
});

describe('messageKey', () => {
  test('accepte un chemin pointé', () => {
    const key = 'tickets.categories.game.name';

    assert.equal(accepts(messageKey(), key), key);
  });

  test('accepte une clé sans point', () => {
    assert.equal(accepts(messageKey(), 'denied'), 'denied');
  });

  test('refuse un chemin mal formé', () => {
    for (const value of ['tickets..name', '.tickets', 'tickets.', 'Tickets.Name', 42]) {
      assert.match(failure(messageKey(), value).message, /chemin pointé vers messages\.yml/);
    }
  });
});
