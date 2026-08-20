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
 * Sous-clé de libellé, quand un même type recouvre deux gestes opposés.
 *
 * `member_timeout` couvre la pose ET la levée : un seul type, une seule entrée
 * de configuration, un seul salon — mais deux phrases à écrire. La variante
 * choisit la clé — `logs.data.member_timeout.set` ou `logs.data.member_timeout.lifted`
 * — et le staff reste maître des deux textes.
 */
const VARIANT = 'variant';

/**
 * Raison saisie par le modérateur, reprise du journal d'audit.
 *
 * **Rendue à part, et non par le gabarit du type.** Elle ne vient pas de
 * l'écouteur mais de la corrélation, et peut donc décorer N'IMPORTE QUEL type
 * corrélé : l'inscrire dans les gabarits obligerait chacun d'eux, présent et à
 * venir, à la porter — et un gabarit qui l'oublierait la stockerait sans jamais
 * l'afficher.
 *
 * Sa ligne n'apparaît que lorsqu'il y en a une. Un modérateur en saisit rarement.
 */
const REASON = 'reason';

/**
 * Clés de `data` qui portent un horodatage.
 *
 * Convention de SUFFIXE plutôt que table par type : `created_at`, `joined_at`,
 * `until`. Une table à tenir divergerait au premier type ajouté par un lot
 * suivant, et la faute serait silencieuse — une date affichée telle quelle, en
 * ISO, au milieu d'une phrase française.
 */
const isTimestamp = (key) => key === 'until' || key.endsWith('_at');

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
   * `data` tel qu'il a été écrit, ou rien.
   *
   * La colonne porte du JSON produit par `createLogEvent()`. Une valeur
   * illisible n'a aucune raison d'exister — nous seuls l'écrivons — mais un
   * `JSON.parse` qui lèverait ici ferait perdre l'embed entier pour un détail
   * accessoire.
   */
  function parseData(event) {
    try {
      const parsed = JSON.parse(event.data ?? '{}');

      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (cause) {
      logger.warn('data illisible à l\'affichage', { type: event.eventType, error: cause });

      return {};
    }
  }

  /**
   * Valeurs de `data`, prêtes pour un gabarit.
   *
   * Deux traitements, et rien d'autre — le reste est l'affaire de
   * `messages.yml`, qui décide seul de la formulation et de la ponctuation.
   *
   * **Les horodatages passent en marquage natif Discord**, `<t:…>`, et non par
   * `formatTime()`. Celui-ci ne rend qu'une heure, sans date : suffisant pour
   * l'instant d'un événement, dont le jour est celui du message, inutilisable
   * pour une date de création de compte ou une échéance d'exclusion, qui sont
   * ailleurs dans le temps. Le marquage natif porte la date entière et
   * l'affiche dans le fuseau de chaque lecteur — le même choix que le pied de
   * page des embeds du socle.
   *
   * **Une valeur absente rend le tiret**, jamais `null` : le moteur de
   * substitution traite `null` comme une variable non fournie, laisserait le
   * marqueur `{joined_at}` visible et journaliserait une erreur à chaque
   * événement.
   */
  function decorate(data) {
    const variables = {};

    for (const [key, value] of Object.entries(data)) {
      if (value === null || value === undefined) {
        variables[key] = text('logs.value.none');
        continue;
      }

      if (isTimestamp(key)) {
        const at = new Date(value);

        variables[key] = Number.isNaN(at.getTime())
          ? text('logs.value.none')
          : `<t:${Math.floor(at.getTime() / 1000)}:f>`;

        continue;
      }

      variables[key] = String(value);
    }

    return variables;
  }

  /**
   * Détail d'un événement : ce qui est propre à son type, puis la raison.
   *
   * **`data` vide vaut « rien à dire », et rend une chaîne vide.** C'est le
   * critère, et il évite une liste de types à tenir à jour en parallèle des
   * clés de `messages.yml` : l'écouteur qui remplit `data` déclare par là même
   * qu'il y a une ligne à afficher, et celui qui n'a rien à dire ne dit rien.
   *
   * Le corollaire à connaître : un type dont l'écouteur remplit `data` SANS clé
   * `logs.data.<type>` correspondante affiche la clé brute et journalise une
   * erreur. C'est bruyant, et c'est voulu — l'inverse cacherait un détail
   * perdu.
   *
   * `reason` ne compte PAS dans ce critère : elle a sa propre ligne, et un
   * bannissement qui n'a qu'elle ne doit pas aller chercher un gabarit
   * `logs.data.member_ban` qui n'existe pas.
   */
  function detail(event) {
    const data = parseData(event);
    const lines = [];

    // Tout sauf la raison : c'est ce qui décide si le type a quelque chose à
    // dire de lui-même. `variant` compte — il choisit le libellé, donc il en
    // porte un.
    const own = Object.keys(data).filter((key) => key !== REASON);

    if (own.length > 0) {
      const variant = data[VARIANT];

      const key =
        variant === undefined
          ? `logs.data.${event.eventType}`
          : `logs.data.${event.eventType}.${variant}`;

      lines.push(text(key, decorate(data)));
    }

    if (data[REASON] != null) {
      lines.push(text('logs.data.reason', { reason: String(data[REASON]) }));
    }

    return lines.join('\n');
  }

  /**
   * Embed riche d'un événement.
   *
   * Les sept variables sont TOUJOURS fournies, jamais nulles : une variable
   * manquante laisserait son marqueur visible dans l'embed, et le moteur de
   * substitution du socle le journaliserait à chaque événement.
   *
   * `data` est la seule qui puisse être VIDE, et seulement quand l'événement n'a
   * rien de particulier à dire : la ligne du gabarit disparaît alors, au lieu
   * d'afficher un tiret que personne ne saurait interpréter.
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
      data: detail(event),
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
