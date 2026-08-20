import { Buffer } from 'node:buffer';

import { AttachmentBuilder } from 'discord.js';

/**
 * Adaptateur d'envoi vers Discord.
 *
 * Traduit le message abstrait du dispatcher — `{ channelId, embeds,
 * attachments }` — en appel `channel.send()`. Le rendeur du lot 4 décrit une
 * pièce jointe par `{ name, content }` et ne connaît pas `AttachmentBuilder` :
 * c'est ici, et nulle part ailleurs, que la conversion a lieu.
 *
 * **Ne lève jamais.** Le dispatcher abandonne déjà un lot en échec — la ligne
 * est en base, c'est ce qui compte — et lui renvoyer une exception ne lui
 * apprendrait rien qu'il puisse traiter autrement. Son propre `try` reste en
 * place comme second garde-fou : il couvre le jour où quelqu'un branchera un
 * autre `send` que celui-ci.
 */

export function createSender({ client, logger }) {
  /**
   * Le cache d'abord, l'API ensuite.
   *
   * Les salons de journalisation sont peu nombreux et permanents : le cache les
   * porte dès la connexion, et `fetch()` ne sert qu'au cas limite d'un salon
   * créé pendant que le bot tourne.
   */
  const channelOf = async (channelId) =>
    client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId));

  /**
   * `{ name, content }` → pièce jointe discord.js.
   *
   * Le texte est encodé en UTF-8 explicitement : le contenu d'un message porte
   * des accents et des émojis, et une conversion implicite dépendrait de la
   * plateforme.
   */
  const fileOf = ({ name, content }) =>
    new AttachmentBuilder(Buffer.from(content, 'utf8'), { name });

  /**
   * @param {{ channelId: string, embeds: object[], attachments?: { name: string, content: string }[] }} message
   * @returns {Promise<object|null>} `null` quand rien n'a pu être envoyé
   */
  return async function send({ channelId, embeds, attachments = [] }) {
    try {
      const channel = await channelOf(channelId);

      // Un salon qui n'accepte pas de message — une catégorie, un salon de
      // forum, un identifiant qui désigne autre chose qu'un salon de texte.
      // `send` absent est le seul critère qui vaille : il couvre les types
      // d'aujourd'hui et ceux que Discord ajoutera.
      if (channel === null || channel === undefined || typeof channel.send !== 'function') {
        logger.warn('salon de journalisation inutilisable', { channel: channelId });

        return null;
      }

      return await channel.send({ embeds, files: attachments.map(fileOf) });
    } catch (cause) {
      // `warn` et non `error` : un salon supprimé, une permission d'écriture
      // retirée ou une limitation de débit ne sont pas des défauts du bot, et
      // aucun ne fait perdre la donnée — elle est déjà en base.
      logger.warn('envoi vers un salon de journalisation impossible', {
        channel: channelId,
        embeds: embeds?.length ?? 0,
        error: cause,
      });

      return null;
    }
  };
}
