/**
 * Ce que le staff reçoit : deux alertes et un journal.
 *
 * **Une mention placée dans un embed ne notifie personne.** Discord l'affiche
 * comme un lien, mais seul le `content` du message déclenche une notification.
 * Écrites dans la description, les deux alertes seraient publiées et
 * resteraient invisibles jusqu'à ce que quelqu'un ouvre le salon par hasard —
 * le symptôme exact d'une mention vers un rôle vide, pour une cause différente.
 *
 * D'où la forme retenue : la mention dans le contenu, le détail dans l'embed.
 *
 * Les mentions autorisées sont ÉNUMÉRÉES. Les textes viennent de
 * `messages.yml`, que le staff édite : un `@everyone` glissé dans un gabarit
 * d'alerte notifierait tout le serveur. `allowedMentions` ferme la porte,
 * quelle que soit la suite du fichier.
 *
 * Rien d'ici n'empêche jamais un membre d'entrer. Un salon supprimé, une
 * permission manquante : l'anomalie est journalisée et la vérification suit son
 * cours.
 */

/** Mention d'un rôle et d'un membre, telles que Discord les rend. */
const roleMention = (roleId) => `<@&${roleId}>`;
const memberMention = (userId) => `<@${userId}>`;

/**
 * Alerte à l'épuisement des tentatives.
 *
 * Déclenchée **uniquement** quand le moteur signale `justBlocked`. Sans cette
 * condition, un membre déjà bloqué qui reclique mentionnerait le rôle à chaque
 * clic — et une alerte qui se répète finit coupée par ceux qui la portent.
 */
export const alertExhausted = (ctx, userId) =>
  send(ctx, {
    capability: 'verification.alert.exhausted',
    channelKey: 'verification.alert.channel_id',
    roleKey: 'verification.alert.exhausted_role_id',
    template: 'verification_alert_exhausted',
    userId,
  });

/**
 * Alerte sur échec d'attribution du rôle.
 *
 * Destinée à un autre public que la précédente : c'est une panne de
 * configuration du serveur, qui empêche TOUTE entrée et doit remonter à qui
 * peut la corriger.
 */
export const alertRoleFailure = (ctx, userId) =>
  send(ctx, {
    capability: 'verification.alert.failure',
    channelKey: 'verification.alert.channel_id',
    roleKey: 'verification.alert.failure_role_id',
    template: 'verification_alert_role_failure',
    userId,
  });

/**
 * Journal d'une vérification réussie.
 *
 * Aucune mention : un salon d'arrivées qui notifie à chaque entrée devient
 * inutilisable dès la première vague. La base enregistre de son côté, y compris
 * les échecs, que ce salon ne reçoit jamais.
 */
export const logVerified = (ctx, userId) =>
  send(ctx, {
    capability: 'verification.log',
    channelKey: 'verification.log.channel_id',
    roleKey: null,
    template: 'verification_log_success',
    userId,
  });

async function send(ctx, { capability, channelKey, roleKey, template, userId }) {
  // Référence introuvable au démarrage : la capacité est éteinte et le salon
  // n'existe probablement plus. Se taire, et laisser le membre entrer.
  if (!ctx.capabilities.isActive(capability)) return false;

  const logger = ctx.logger.forModule(ctx.module);
  const roleId = roleKey === null ? null : ctx.config.get(roleKey);

  try {
    const channel = await ctx.client.channels.fetch(ctx.config.get(channelKey));

    await channel.send({
      // La mention vit ici, jamais dans l'embed : elle n'y notifierait personne.
      ...(roleId === null ? {} : { content: roleMention(roleId) }),
      embeds: [ctx.embeds.render(template, { member: memberMention(userId) })],
      // Énumération stricte : ni @everyone, ni les rôles qu'un gabarit pourrait
      // nommer, ni le membre concerné, qu'il est inutile de notifier.
      allowedMentions: roleId === null ? { parse: [] } : { roles: [roleId] },
    });

    return true;
  } catch (error) {
    // Une alerte qui n'aboutit pas ne doit rien coûter au membre : il vient
    // peut-être d'obtenir son rôle.
    logger.error('notification staff impossible', { capability, user: userId, error });

    return false;
  }
}
