import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { Configuration } from '../../../src/core/config/index.js';
import { createEmbedEngine } from '../../../src/core/embeds/index.js';
import { buildConfigSchema } from '../../../src/core/config/schema/core.schema.js';
import { ACTOR_CONFIDENCE, EVENT_SOURCE, LOG_EVENTS } from '../../../src/modules/logs/constants.js';
import { createLogEvent } from '../../../src/modules/logs/event.js';
import { schema } from '../../../src/modules/logs/manifest.js';
import { createRenderer } from '../../../src/modules/logs/render.js';

/**
 * Rendu des événements en embeds.
 *
 * Tourne sur les fichiers RÉELLEMENT LIVRÉS — `messages.yml` et `embeds.yml` du
 * dépôt — et non sur des gabarits inventés : un rendu validé contre des textes
 * de test ne prouverait pas que les fichiers versionnés fonctionnent.
 *
 * Aucun import de discord.js : une pièce jointe est décrite par
 * `{ name, content }`, la conversion appartient au lot 5.
 */

const MEMBRE = '123456789012345678';
const MODERATEUR = '111111111111111111';
const SALON = '222222222222222222';

const AT = new Date(Date.UTC(2026, 6, 15, 12, 0, 0, 0));

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

const config = new Configuration({ configSchema: buildConfigSchema({ logs: schema }) });

config.load();

const build = ({ logger = fakeLogger() } = {}) => ({
  logger,
  renderer: createRenderer({
    embeds: createEmbedEngine({ config, logger }),
    config,
    logger,
  }),
});

const record = ({ id = 1, channelKey = 'messages', ...patch } = {}) => ({
  id,
  event: createLogEvent({
    type: 'message_delete',
    occurredAt: AT,
    actorId: null,
    actorConfidence: ACTOR_CONFIDENCE.unknown,
    targetId: MEMBRE,
    channelId: SALON,
    source: EVENT_SOURCE.live,
    ...patch,
  }),
  routing: { channelKey, channelId: SALON, deliverable: true, reason: null },
});

const seuil = config.get('logs.attachment_threshold');

describe('embed riche', () => {
  test('porte le type, l\'heure, la cible et le salon', () => {
    const { renderer } = build();

    const { embed } = renderer.renderRich(record());

    // Le libellé vient de messages.yml, jamais du code.
    assert.match(embed.description, /Message supprimé/);
    // 12h UTC = 14h à Paris en juillet.
    assert.match(embed.description, /14:00:00/);
    assert.match(embed.description, new RegExp(`<@${MEMBRE}>`));
    assert.match(embed.description, new RegExp(`<#${SALON}>`));
  });

  test('un gabarit par famille, pas par type', () => {
    // Trente-trois gabarits seraient ingérables : le type est une variable.
    const { renderer } = build();

    const familles = new Set();

    for (const channelKey of ['messages', 'voice', 'members', 'server', 'moderation']) {
      const { embed } = renderer.renderRich(record({ channelKey, type: 'member_ban', channelId: null }));

      familles.add(embed.title);
    }

    assert.equal(familles.size, 5, 'chaque famille a son titre');
  });

  test('aucun marqueur de variable ne subsiste', () => {
    // Les six variables sont toujours fournies : un marqueur resté visible
    // signalerait un oubli, et le moteur du socle le journaliserait à chaque
    // événement.
    const { renderer, logger } = build();

    for (const type of LOG_EVENTS) {
      const { embed } = renderer.renderRich(record({ type, channelId: null, content: null }));

      assert.doesNotMatch(embed.description, /\{[a-z][a-z0-9_]*\}/, type);
    }

    assert.equal(logger.of('error').length, 0, 'aucune variable manquante');
  });

  test('une valeur absente rend un tiret, jamais un blanc', () => {
    const { renderer } = build();

    const { embed } = renderer.renderRich(
      record({ type: 'guild_update', channelKey: 'server', targetId: null, channelId: null }),
    );

    assert.match(embed.description, /—/);
  });
});

describe('auteur et réserve', () => {
  test('un auteur probable n\'est JAMAIS affirmé catégoriquement', () => {
    // Contrepartie directe du lot 3 : la corrélation est faillible dès que deux
    // actions semblables tombent dans la même seconde.
    const { renderer } = build();

    const { embed } = renderer.renderRich(
      record({ actorId: MODERATEUR, actorConfidence: ACTOR_CONFIDENCE.probable }),
    );

    assert.match(embed.description, new RegExp(`<@${MODERATEUR}>`));
    assert.match(embed.description, /probable/i, 'la réserve est portée par le texte');
  });

  test('un auteur certain est nommé sans réserve', () => {
    const { renderer } = build();

    const { embed } = renderer.renderRich(
      record({
        type: 'message_edit',
        actorId: MEMBRE,
        actorConfidence: ACTOR_CONFIDENCE.certain,
        content: { authorId: MEMBRE, before: 'a', after: 'b' },
      }),
    );

    assert.match(embed.description, new RegExp(`<@${MEMBRE}>`));
    assert.doesNotMatch(embed.description, /probable/i);
  });

  test('un auteur unknown ne nomme PERSONNE', () => {
    const { renderer } = build();

    const { embed } = renderer.renderRich(record({ actorId: null }));

    assert.match(embed.description, /auteur inconnu/i);
    assert.doesNotMatch(embed.description, new RegExp(`<@${MODERATEUR}>`));
  });

  test('les trois libellés diffèrent', () => {
    const { renderer } = build();

    const rendus = [
      renderer.renderRich(record({ actorId: null })),
      renderer.renderRich(
        record({ actorId: MODERATEUR, actorConfidence: ACTOR_CONFIDENCE.probable }),
      ),
      renderer.renderRich(
        record({
          type: 'message_edit',
          actorId: MODERATEUR,
          actorConfidence: ACTOR_CONFIDENCE.certain,
        }),
      ),
    ].map((held) => held.embed.description);

    assert.equal(new Set(rendus).size, 3);
  });
});

describe('contenu et pièce jointe', () => {
  const court = 'a'.repeat(10);
  const long = 'b'.repeat(seuil + 1);

  test('un contenu sous le seuil reste dans l\'embed', () => {
    const { renderer } = build();

    const { embed, attachment } = renderer.renderRich(
      record({ content: { authorId: MEMBRE, before: court } }),
    );

    assert.equal(attachment, null);
    assert.match(embed.description, new RegExp(court));
  });

  test('un contenu au-dessus du seuil part en pièce jointe', () => {
    const { renderer } = build();

    const { embed, attachment } = renderer.renderRich(
      record({ content: { authorId: MEMBRE, before: long } }),
    );

    assert.notEqual(attachment, null);
    assert.equal(attachment.content, long, 'le contenu est INTÉGRAL, jamais tronqué');
    assert.doesNotMatch(embed.description, /b{50}/, 'et il n\'est pas aussi dans l\'embed');
    assert.match(embed.description, /joint en fichier/i);
  });

  test('l\'embed n\'est pas tronqué : il porte le contexte', () => {
    const { renderer, logger } = build();

    const { embed } = renderer.renderRich(record({ content: { authorId: MEMBRE, before: long } }));

    assert.match(embed.description, /Message supprimé/);
    assert.match(embed.description, new RegExp(`<@${MEMBRE}>`));
    assert.equal(
      logger.of('warn').filter((held) => held.message.includes('tronqué')).length,
      0,
      'le moteur du socle n\'a rien eu à couper',
    );
  });

  test('avant et après sont tous deux rendus sur une modification', () => {
    const { renderer } = build();

    const { embed } = renderer.renderRich(
      record({
        type: 'message_edit',
        actorId: MEMBRE,
        actorConfidence: ACTOR_CONFIDENCE.certain,
        content: { authorId: MEMBRE, before: 'avant-x', after: 'apres-y' },
      }),
    );

    assert.match(embed.description, /avant-x/);
    assert.match(embed.description, /apres-y/);
  });

  test('un événement sans contenu n\'a pas de pièce jointe', () => {
    const { renderer } = build();

    const { attachment } = renderer.renderRich(
      record({ type: 'member_ban', channelKey: 'moderation', channelId: null }),
    );

    assert.equal(attachment, null);
  });
});

describe('nom de fichier', () => {
  test('ne contient RIEN qui vienne d\'un membre', () => {
    // Un pseudo Discord peut porter des barres obliques, des points ou des
    // caractères de contrôle : un nom de fichier fabriqué à partir de là n'est
    // plus un nom de fichier.
    const { renderer } = build();
    const pseudo = '../../etc/passwd';

    const { attachment } = renderer.renderRich(
      record({
        id: 42,
        content: { authorId: MEMBRE, before: `${'x'.repeat(seuil + 1)} ${pseudo}` },
      }),
    );

    assert.equal(attachment.name, 'message_delete-42.txt');
    assert.doesNotMatch(attachment.name, /\.\.|\//);
    assert.doesNotMatch(attachment.name, new RegExp(MEMBRE));
  });

  test('se compose du type et de l\'identifiant de l\'événement', () => {
    const { renderer } = build();

    const { attachment } = renderer.renderRich(
      record({
        id: 7,
        type: 'message_bulk_delete',
        content: { authorId: MEMBRE, before: 'y'.repeat(seuil + 1) },
      }),
    );

    assert.equal(attachment.name, 'message_bulk_delete-7.txt');
  });
});

describe('embed condensé', () => {
  const lot = (n, patch = {}) =>
    Array.from({ length: n }, (_, i) => record({ id: i + 1, ...patch }));

  test('une ligne par événement, avec l\'heure', () => {
    const { renderer } = build();

    const { embed } = renderer.renderCompact(lot(3));

    assert.equal(embed.description.split('\n').length, 3);
    assert.equal((embed.description.match(/14:00:00/g) ?? []).length, 3);
  });

  test('AUCUN contenu de message dans les lignes', () => {
    // Une énumération se parcourt en diagonale : un contenu la rendrait
    // illisible.
    const { renderer } = build();

    const { embed } = renderer.renderCompact(
      lot(3, { content: { authorId: MEMBRE, before: 'SECRET_INLINE' } }),
    );

    assert.doesNotMatch(embed.description, /SECRET_INLINE/);
  });

  test('les contenus du lot partent dans UNE pièce jointe', () => {
    // Un fichier par événement dépasserait le plafond de fichiers d'un message
    // dès qu'une purge dépasse la dizaine.
    const { renderer } = build();

    const { attachments } = renderer.renderCompact(
      lot(12, { content: { authorId: MEMBRE, before: 'texte-du-message' } }),
    );

    assert.equal(attachments.length, 1);
    assert.equal((attachments[0].content.match(/texte-du-message/g) ?? []).length, 12);
  });

  test('sans contenu, aucune pièce jointe', () => {
    const { renderer } = build();

    const { attachments } = renderer.renderCompact(
      lot(4, { type: 'member_ban', channelKey: 'moderation', channelId: null }),
    );

    assert.deepEqual(attachments, []);
  });

  test('le nom du fichier ne vient pas non plus d\'un membre', () => {
    const { renderer } = build();

    const { attachments } = renderer.renderCompact(
      lot(2, { content: { authorId: MEMBRE, before: 'x' } }),
    );

    assert.match(attachments[0].name, /^\d+-\d+\.txt$/);
    assert.doesNotMatch(attachments[0].name, new RegExp(MEMBRE));
  });

  test('un seul embed, quel que soit le nombre d\'événements', () => {
    const { renderer } = build();

    const rendu = renderer.renderCompact(lot(40));

    assert.equal(typeof rendu.embed, 'object');
    assert.equal(Array.isArray(rendu.embed), false);
  });
});
