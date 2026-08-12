import assert from 'node:assert/strict';
import { test } from 'node:test';

import yaml from 'js-yaml';

import { CONFIG_FILES, loadYamlFiles } from '../../../src/core/config/loader.js';
import { tempDir } from '../../helpers/fixtures.js';

const VALID = {
  'config.yml': 'bot:\n  guild_id: "123456789012345678"\n',
  'messages.yml': 'commands:\n  denied: "Commande refusée."\n',
  'embeds.yml': 'footer:\n  text: "Cubex"\n',
};

test('lit les trois fichiers et n\'en signale aucun', (t) => {
  const dir = tempDir(t, VALID);

  const { files, errors } = loadYamlFiles({ dir });

  assert.deepEqual(errors, []);
  assert.equal(files.config.bot.guild_id, '123456789012345678');
  assert.equal(files.messages.commands.denied, 'Commande refusée.');
  assert.equal(files.embeds.footer.text, 'Cubex');
});

test('signale un fichier introuvable en le nommant', (t) => {
  const dir = tempDir(t, { 'config.yml': VALID['config.yml'] });

  const { files, errors } = loadYamlFiles({ dir });

  assert.equal(errors.length, 2);
  assert.deepEqual(
    errors.map((error) => error.file).sort(),
    ['embeds.yml', 'messages.yml'],
  );
  assert.match(errors[0].message, /introuvable/);
  assert.equal(files.messages, null);
});

test('signale un YAML mal formé avec le fichier et la ligne', (t) => {
  const dir = tempDir(t, {
    ...VALID,
    'config.yml': 'bot:\n  guild_id: "123"\n   mauvaise_indentation: 1\n',
  });

  const { files, errors } = loadYamlFiles({ dir });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'config.yml');
  assert.equal(errors[0].line, 3);
  assert.match(errors[0].message, /YAML invalide/);
  assert.equal(errors[0].location, 'config.yml (ligne 3)');
  assert.equal(files.config, null);
});

test('refuse une clé dupliquée', (t) => {
  const dir = tempDir(t, {
    ...VALID,
    'config.yml': 'bot:\n  guild_id: "1"\nbot:\n  guild_id: "2"\n',
  });

  const { errors } = loadYamlFiles({ dir });

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /duplicat/i);
});

test('refuse un fichier vide', (t) => {
  const dir = tempDir(t, { ...VALID, 'messages.yml': '# rien que des commentaires\n' });

  const { errors } = loadYamlFiles({ dir });

  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, 'messages.yml');
  assert.match(errors[0].message, /vide/);
});

test('refuse une racine qui n\'est pas un ensemble de clés', (t) => {
  const dir = tempDir(t, { ...VALID, 'embeds.yml': '- premier\n- second\n' });

  const { errors } = loadYamlFiles({ dir });

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /racine du document/);
  assert.match(errors[0].message, /une liste/);
});

test('tente les trois fichiers même quand le premier échoue', (t) => {
  const dir = tempDir(t, {
    'config.yml': ':\n:\n',
    'messages.yml': '',
    'embeds.yml': '- liste\n',
  });

  const { errors } = loadYamlFiles({ dir });

  assert.equal(errors.length, 3);
  assert.deepEqual(
    errors.map((error) => error.file),
    Object.values(CONFIG_FILES),
  );
});

// Ce test ne porte pas sur le chargeur mais sur js-yaml, et justifie la
// primitive snowflake() : l'identifiant est déjà corrompu quand la validation
// le reçoit, sa valeur ne doit donc jamais être citée dans un message d'erreur.
test('un identifiant Discord sans guillemets est lu comme un nombre corrompu', () => {
  const parsed = yaml.load('roles:\n  member: 1234567890123456789\n');

  assert.equal(typeof parsed.roles.member, 'number');
  assert.notEqual(String(parsed.roles.member), '1234567890123456789');
});
