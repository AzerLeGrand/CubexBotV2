import { ACTOR_CONFIDENCE, LOG_CHANNELS, MESSAGE_EVENTS } from './constants.js';
import { formatTime, INVALID_TIME } from './format.js';

/**
 * Rendu des événements en embeds.
 *
 * **Aucun texte n'est écrit ici.** Tout vient de `messages.yml` et
 * d'`embeds.yml` : le rendeur compose des variables, il ne rédige pas. Aucun
 * import de discord.js non plus — une pièce jointe est décrite par
 * `{ name, content }`, la conversion appartient au lot 5.
 *
 * **Un gabarit ne porte qu'une couleur, un titre et une description** : le
 * schéma du socle n'accepte pas de champs. Toute la mise en page vit donc dans
 * `messages.yml`, où chaque famille a sa description et où le staff peut
 * réordonner les lignes sans toucher au code.
 *
 * Les mentions insérées ici ne notifient personne : Discord ne déclenche de
 * notification que depuis le `content` d'un message, jamais depuis un embed.
 * C'est ce qui permet de nommer librement un membre dans un journal.
 */

/** Famille d'affichage d'un type, dérivée du salon vers lequel il pointe. */
const FAMILY_TEMPLATES = Object.freeze(
  Object.fromEntries(LOG_CHANNELS.map((key) => [key, `log_${key}`])),
);

/** Gabarit du rendu condensé. */
const COMPACT_TEMPLATE = 'log_compact';

/**
 * Extension du fichier de contenu.
 *
 * `.txt` et non `.log` ou `.md` : Discord prévisualise le texte brut dans le
 * client, ce qui évite un téléchargement pour lire trois lignes.
 */
const ATTACHMENT_EXTENSION = '.txt';

export function createRenderer({ embeds, config, logger }) {
  const timezone = () => config.get('bot.timezone');
  const threshold = () => config.get('logs.attachment_threshold');

  const text = (key, variables) => config.text(key, variables);

  /** Mention d'un membre, ou le tiret d'absence. */
  const user = (id) => (id === null || id === undefined ? text('logs.value.none') : `<@${id}>`);

  const channel = (id) => (id === null || id === undefined ? text('logs.value.none') : `<#${id}>`);

  /**
   * Heure d'affichage, dans le fuseau du serveur.
   *
   * Un horodatage illisible est journalisé ici plutôt que dans `format.js`, qui
   * reste une fonction pure : c'est le rendeur qui a le logger.
   */
  function time(event) {
    const formatted = formatTime(event.occurredAt, timezone());

    if (formatted === INVALID_TIME) {
      logger.warn('horodatage illisible à l\'affichage', {
        type: event.eventType,
        // La valeur n'est pas citée : `occurred_at` est écrit par nous, mais ces
        // journaux partiront vers Discord en phase 6.
        length: String(event.occurredAt ?? '').length,
      });
    }

    return formatted;
  }

  /**
   * Auteur de l'action, avec sa réserve.
   *
   * **Jamais d'affirmation catégorique sur un auteur `probable`.** C'est la
   * contrepartie directe du lot 3 : la corrélation se fait sur le salon, la
   * cible et une fenêtre temporelle, elle est faillible dès que deux actions
   * semblables tombent dans la même seconde. Le texte porte la réserve, pas une
   * nuance de couleur qu'on oublierait de lire.
   */
  function actor(event) {
    if (event.actorConfidence === ACTOR_CONFIDENCE.unknown || event.actorId === null) {
      // Personne n'est nommé. Le libellé le dit explicitement plutôt que de
      // laisser un blanc, qui passerait pour un oubli d'affichage.
      return text('logs.actor.unknown');
    }

    return text(`logs.actor.${event.actorConfidence}`, { user: `<@${event.actorId}>` });
  }

  /**
   * Nom du fichier de contenu.
   *
   * **Rien de ce qui vient d'un membre n'y entre** : ni pseudo, ni contenu. Un
   * pseudo Discord peut porter des barres obliques, des points ou des caractères
   * de contrôle, et un nom de fichier fabriqué à partir de là n'est plus un nom
   * de fichier. Le type et l'identifiant de l'événement viennent tous deux du
   * code et de la base.
   */
  const fileName = (event, id) => `${event.eventType}-${id}${ATTACHMENT_EXTENSION}`;

  /** Contenu brut d'un message, avant ou après, tel qu'il ira au fichier. */
  const rawContent = (event) =>
    [event.content?.before, event.content?.after].filter((part) => part != null).join('\n\n');

  /**
   * Contenu affiché dans un embed riche, ou renvoi vers la pièce jointe.
   *
   * **Jamais de troncature.** Au-delà du seuil, le contenu part intégralement en
   * fichier : couper la fin d'un message supprimé, c'est perdre précisément ce
   * qu'on cherchait en ouvrant le journal.
   *
   * @returns {{ text: string, attachment: { name: string, content: string }|null }}
   */
  function content(event, id) {
    if (!MESSAGE_EVENTS.includes(event.eventType) || event.content == null) {
      return { text: text('logs.value.none'), attachment: null };
    }

    const raw = rawContent(event);

    if (raw.length === 0) return { text: text('logs.value.none'), attachment: null };

    if (raw.length > threshold()) {
      const name = fileName(event, id);

      return {
        text: text('logs.content.attached', { file: name }),
        attachment: { name, content: raw },
      };
    }

    const parts = [];

    if (event.content.before != null) {
      parts.push(text('logs.content.before', { text: event.content.before }));
    }

    if (event.content.after != null) {
      parts.push(text('logs.content.after', { text: event.content.after }));
    }

    return { text: parts.join('\n\n'), attachment: null };
  }

  /**
   * Embed riche d'un événement.
   *
   * Les six variables sont TOUJOURS fournies, jamais vides : une variable
   * manquante laisserait son marqueur visible dans l'embed, et le moteur de
   * substitution du socle le journaliserait à chaque événement.
   *
   * @param {{ id: number, event: object, routing: object }} record
   * @returns {{ embed: object, attachment: { name: string, content: string }|null }}
   */
  function renderRich({ id, event, routing }) {
    const rendered = content(event, id);

    const embed = embeds.render(FAMILY_TEMPLATES[routing.channelKey] ?? FAMILY_TEMPLATES.server, {
      type: text(`logs.type.${event.eventType}`),
      time: time(event),
      target: user(event.targetId),
      actor: actor(event),
      channel: channel(event.channelId),
      content: rendered.text,
    });

    return { embed, attachment: rendered.attachment };
  }

  /**
   * Embed condensé d'un lot.
   *
   * Une ligne courte par événement, et **aucun contenu de message dans ces
   * lignes** : une énumération se parcourt en diagonale, un contenu la rendrait
   * illisible. Les contenus du lot partent dans une pièce jointe unique.
   *
   * Un seul fichier plutôt qu'un par événement : Discord plafonne le nombre de
   * fichiers d'un message, et une purge de cent messages en produirait cent.
   *
   * @param {{ id: number, event: object, routing: object }[]} records
   * @returns {{ embed: object, attachments: { name: string, content: string }[] }}
   */
  function renderCompact(records) {
    const lines = [];
    const entries = [];

    for (const { id, event } of records) {
      const at = time(event);

      lines.push(
        text('logs.compact.line', {
          time: at,
          type: text(`logs.type.${event.eventType}`),
          target: user(event.targetId),
          actor: actor(event),
        }),
      );

      const raw = rawContent(event);

      if (raw.length === 0) continue;

      entries.push(
        text('logs.attachment.entry', {
          time: at,
          type: text(`logs.type.${event.eventType}`),
          // L'identifiant brut et non une mention : un fichier texte n'affiche
          // pas les mentions, elles y resteraient sous leur forme `<@…>`.
          author: event.content?.authorId ?? text('logs.value.none'),
          content: raw,
        }),
      );

      void id;
    }

    const embed = embeds.render(COMPACT_TEMPLATE, { lines: lines.join('\n') });

    if (entries.length === 0) return { embed, attachments: [] };

    // Nom dérivé du premier identifiant et du nombre d'entrées : deux valeurs du
    // code et de la base, jamais d'un membre.
    const name = `${records[0].id}-${entries.length}${ATTACHMENT_EXTENSION}`;

    return { embed, attachments: [{ name, content: entries.join('\n') }] };
  }

  return { renderRich, renderCompact };
}
