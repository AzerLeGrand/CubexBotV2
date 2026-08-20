import { RESTJSONErrorCodes } from 'discord.js';

/**
 * Adaptateur vers les rôles d'un membre.
 *
 * Traduit `guild.members` vers le contrat `resolveRoles` que les exclusions du
 * lot 3 attendent : un identifiant de membre, une liste d'identifiants de rôles.
 *
 * **Ne lève jamais.** Un membre introuvable rend une liste vide, et c'est le cas
 * ORDINAIRE, pas une anomalie : le membre qui vient de quitter le serveur est
 * précisément celui dont on journalise le départ. Les exclusions traitent une
 * liste vide comme « aucun rôle », donc « pas exclu par rôle » — direction sûre,
 * puisqu'un événement ignoré à tort ne laisse aucune trace, là où un événement
 * de trop se corrige en lisant le salon.
 */

export function createRoleSource({ guild, logger }) {
  /**
   * Le cache d'abord, l'API ensuite.
   *
   * Avec l'intent `GuildMembers`, le cache couvre la quasi-totalité des cas et
   * une requête par événement serait une dépense pure. Le repli sur `fetch()`
   * couvre le membre absent du cache — un bot qui vient de démarrer, un membre
   * évincé du cache.
   */
  const memberOf = async (userId) =>
    guild.members.cache.get(userId) ?? (await guild.members.fetch(userId));

  return async function resolveRoles(userId) {
    if (typeof userId !== 'string' || userId.length === 0) return [];

    try {
      const member = await memberOf(userId);

      // `@everyone` est inclus tel que Discord le rend : son identifiant vaut
      // celui du serveur. Le filtrer serait décider à la place du staff — une
      // exclusion portant sur `@everyone` est un réglage absurde mais explicite,
      // et le retirer en silence ferait mentir la liste.
      return [...member.roles.cache.keys()];
    } catch (cause) {
      // Deux natures d'échec, deux niveaux, et la distinction compte : elle
      // décide de ce qu'on voit dans le fichier de journal.
      //
      // Membre inconnu — il a quitté le serveur — est le cas NORMAL sur un
      // départ, une expulsion ou un bannissement. L'annoncer comme une anomalie
      // produirait un avertissement par départ et noierait les vraies.
      //
      // Tout le reste — permission retirée, panne d'API — est un défaut
      // d'exploitation qui rend les exclusions par rôle inopérantes en silence.
      // Nul autre endroit ne le verra : on ne lève pas, donc le garde-fou des
      // exclusions ne s'en apercevra pas.
      const expected = cause?.code === RESTJSONErrorCodes.UnknownMember;

      logger[expected ? 'debug' : 'warn']("rôles d'un membre illisibles", {
        user: userId,
        error: cause,
      });

      return [];
    }
  };
}
