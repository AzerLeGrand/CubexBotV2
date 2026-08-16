import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

import { encodeCustomId } from '../../core/components/index.js';

import { ACTIONS } from './constants.js';

/**
 * Message permanent du salon de vérification.
 *
 * **Un seul chemin d'écriture**, appelé par `ready(ctx)` au démarrage et par
 * l'écouteur `messageDelete` en cours de fonctionnement. Deux chemins
 * divergeraient dès la première modification, et le salon finirait avec deux
 * messages d'accueil ou aucun.
 *
 * **La présence est vérifiée, jamais le contenu.** Modifier `messages.yml`
 * n'entraîne donc aucune republication : le staff supprime le message à la
 * main, ce qui déclenche l'écouteur. C'est délibéré — comparer les contenus
 * ferait republier à chaque ajustement de texte, et il faudrait décider ce qui
 * compte comme une différence. Ne pas ajouter cette comparaison.
 */

/** Vue de la table, pour ne pas dépendre de l'ordre de montage des modules. */
let repositoryOf = null;

/** Injecté par `init()` : le dépôt n'existe pas avant le montage du module. */
export const useRepository = (repository) => {
  repositoryOf = repository;
};

/**
 * Identifiant du message d'accueil enregistré pour ce salon, ou `null`.
 *
 * Passe par ce fichier plutôt que par le dépôt directement : la table du
 * message a UN seul lecteur comme elle a un seul écrivain. Deux accès
 * divergeraient — l'écouteur pourrait filtrer sur un état que la publication ne
 * connaît pas.
 */
export const storedWelcomeId = (channelId) => repositoryOf?.message.find(channelId)?.message_id ?? null;

/**
 * Publication en cours.
 *
 * `ready` et un `messageDelete` simultanés publieraient deux messages d'accueil
 * — exactement ce que le stockage en base cherche à éviter. Le second appel
 * attend le premier et lit son résultat.
 */
let inFlight = null;

/**
 * Garantit qu'un message d'accueil est présent dans le salon configuré.
 *
 * @returns {Promise<{ action: 'kept'|'published'|'republished', messageId: string }>}
 */
export function ensureWelcome(ctx) {
  if (inFlight !== null) return inFlight;

  inFlight = publishIfMissing(ctx).finally(() => {
    inFlight = null;
  });

  return inFlight;
}

async function publishIfMissing(ctx) {
  const channelId = ctx.config.get('verification.channel_id');

  // `fetch` et non le cache : au démarrage, le cache d'un salon jamais vu est
  // vide, et s'y fier ferait republier alors que tout va bien.
  const channel = await ctx.client.channels.fetch(channelId);
  const stored = repositoryOf.message.find(channelId);

  if (stored !== null && (await exists(channel, stored.message_id))) {
    return { action: 'kept', messageId: stored.message_id };
  }

  const message = await channel.send(payload(ctx));

  // Enregistré immédiatement : c'est ce qui rend la boucle impossible. Un
  // `messageDelete` portant l'ancien identifiant ne correspond plus à celui de
  // la base, donc l'écouteur l'ignore.
  repositoryOf.message.save(channelId, message.id);

  return { action: stored === null ? 'published' : 'republished', messageId: message.id };
}

/** Le message existe-t-il encore ? `null` et l'échec de récupération se valent. */
async function exists(channel, messageId) {
  try {
    return (await channel.messages.fetch(messageId)) !== null;
  } catch {
    // discord.js lève sur un message supprimé plutôt que de rendre null.
    return false;
  }
}

/** Embed et bouton, tous deux issus de la configuration. */
function payload(ctx) {
  const button = new ButtonBuilder()
    .setCustomId(encodeCustomId(ctx.module, ACTIONS.start))
    .setLabel(ctx.config.text('verification.buttons.start'))
    .setStyle(ButtonStyle.Primary);

  return {
    embeds: [ctx.embeds.render('verification_welcome')],
    components: [new ActionRowBuilder().addComponents(button)],
  };
}
