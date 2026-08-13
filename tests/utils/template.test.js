import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { render, variablesOf } from '../../src/utils/template.js';

describe('render', () => {
  test('substitue une variable', () => {
    const { text, missing } = render('Bienvenue {username}.', { username: 'Azer' });

    assert.equal(text, 'Bienvenue Azer.');
    assert.deepEqual(missing, []);
  });

  test('substitue toutes les occurrences d\'une même variable', () => {
    const { text } = render('{username}, {username} et encore {username}', { username: 'Azer' });

    assert.equal(text, 'Azer, Azer et encore Azer');
  });

  test('convertit les nombres et les booléens', () => {
    const { text, missing } = render('{count} anomalies, actif : {enabled}', {
      count: 40,
      enabled: false,
    });

    assert.equal(text, '40 anomalies, actif : false');
    assert.deepEqual(missing, []);
  });

  test('substitue zéro et la chaîne vide, qui sont des valeurs', () => {
    const { text, missing } = render('[{count}][{reason}]', { count: 0, reason: '' });

    assert.equal(text, '[0][]');
    assert.deepEqual(missing, []);
  });

  test('laisse le marqueur en place et signale la variable manquante', () => {
    // Socle §9 : jamais d'affichage vide silencieux. Un marqueur resté visible
    // se remarque, une phrase amputée non.
    const { text, missing } = render('Bonjour {username}, tu as {count} tickets.', { count: 2 });

    assert.equal(text, 'Bonjour {username}, tu as 2 tickets.');
    assert.deepEqual(missing, ['username']);
  });

  test('traite null et undefined comme des valeurs manquantes', () => {
    const { text, missing } = render('{a}{b}', { a: null, b: undefined });

    assert.equal(text, '{a}{b}');
    assert.deepEqual(missing, ['a', 'b']);
  });

  test('ne signale qu\'une fois une variable manquante répétée', () => {
    const { missing } = render('{username} {username} {username}', {});

    assert.deepEqual(missing, ['username']);
  });

  test('ignore sans bruit une variable fournie mais inutilisée', () => {
    const { text, missing } = render('Bonjour {username}.', {
      username: 'Azer',
      inutile: 'ignorée',
    });

    assert.equal(text, 'Bonjour Azer.');
    assert.deepEqual(missing, []);
  });

  test('laisse intacte une accolade qui n\'encadre pas un nom conforme', () => {
    // Le motif strict tient lieu d'échappement : un extrait de JSON ou de CSS
    // dans un message ne doit pas être touché, ni signalé comme manquant.
    for (const inchangé of ['{"a": 1}', '{USERNAME}', '{123}', '{ username }', '{}', '{a-b}']) {
      const { text, missing } = render(inchangé, {});

      assert.equal(text, inchangé);
      assert.deepEqual(missing, []);
    }
  });

  test('joint une liste de lignes par des sauts de ligne', () => {
    const { text } = render(['Première ligne.', 'Seconde, avec {username}.'], { username: 'Azer' });

    assert.equal(text, 'Première ligne.\nSeconde, avec Azer.');
  });

  test('rend un texte sans variable à l\'identique', () => {
    const { text, missing } = render('Aucune variable ici.', { username: 'Azer' });

    assert.equal(text, 'Aucune variable ici.');
    assert.deepEqual(missing, []);
  });

  test('accepte un appel sans variables', () => {
    assert.deepEqual(render('{username}'), { text: '{username}', missing: ['username'] });
  });

  test('ne réinjecte pas une variable contenue dans une valeur substituée', () => {
    // Une seule passe : un pseudo malveillant ne peut pas faire apparaître le
    // contenu d'une autre variable.
    const { text } = render('{username} a écrit', { username: '{token}', token: 'secret' });

    assert.equal(text, '{token} a écrit');
  });

  test('rend le gabarit de nommage des salons de ticket', () => {
    // Le moteur s'applique aussi à des valeurs de config.yml.
    const { text } = render('ticket-{number}-{username}', { number: 42, username: 'azer' });

    assert.equal(text, 'ticket-42-azer');
  });
});

describe('variablesOf', () => {
  test('liste les variables dans l\'ordre d\'apparition, sans doublon', () => {
    assert.deepEqual(variablesOf('{b} {a} {b} {c}'), ['b', 'a', 'c']);
  });

  test('ne retient pas les accolades non conformes', () => {
    assert.deepEqual(variablesOf('{"a": 1} {UPPER} {ok}'), ['ok']);
  });

  test('accepte une liste de lignes', () => {
    assert.deepEqual(variablesOf(['{count} erreurs', 'dont {shown} affichées']), [
      'count',
      'shown',
    ]);
  });

  test('rend une liste vide pour un texte sans variable', () => {
    assert.deepEqual(variablesOf('Aucune variable.'), []);
  });
});
