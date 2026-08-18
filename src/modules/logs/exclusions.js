import { MESSAGE_EVENTS } from './constants.js';

/**
 * Filtrage par exclusions (spec §4).
 *
 * **L'exclusion porte sur l'AUTEUR DE L'ACTION, jamais sur le message
 * concerné.** Cette distinction est tout le mécanisme, et elle produit un
 * tableau contre-intuitif :
 *
 * | Situation                                             | Comportement   |
 * |-------------------------------------------------------|----------------|
 * | Le bot écrit un log                                   | non journalisé |
 * | Un modérateur supprime un message du bot              | **journalisé** |
 * | Un membre écrit dans un salon exclu                   | non journalisé |
 * | Un modérateur supprime un message dans un salon exclu | **journalisé** |
 *
 * Un filtrage sur le seul auteur du message rendrait invisibles les actions des
 * modérateurs sur les messages du bot — c'est-à-dire précisément ce qu'on veut
 * voir. D'où l'ordre : la corrélation d'abord, l'exclusion ensuite.
 *
 * **Aucun import de discord.js.** `resolveRoles` est injecté au câblage.
 */

export function createExclusions({ config, resolveRoles, botUserId, logger }) {
  /**
   * L'identifiant du bot est lu par une FONCTION, pas reçu en valeur.
   *
   * Il vient de `client.user.id` et n'existe donc qu'après la connexion, alors
   * que ce module est monté avant. Un accesseur laisse le câblage tardif du
   * lot 5 le fournir sans rien reconstruire.
   *
   * Il ne vient JAMAIS d'une entrée de configuration : une garantie structurelle
   * ne doit pas dépendre d'une valeur éditable, qu'un vidage de liste ou une
   * application Discord recréée suffirait à lever en silence.
   */
  const selfId = () => (typeof botUserId === 'function' ? botUserId() : (botUserId ?? null));

  const list = (key) => config.get(`logs.exclusions.${key}`, []);

  const isSelf = (userId) => {
    const self = selfId();

    return self !== null && userId === self;
  };

  /**
   * Rôles d'un membre, ou aucun.
   *
   * Un échec est journalisé en `warn` et traité comme « pas de rôle ». **Ne
   * jamais exclure par défaut** : ignorer un événement à tort le fait
   * disparaître sans laisser de trace, alors qu'en journaliser un de trop se
   * corrige en lisant le salon.
   */
  async function rolesOf(userId) {
    if (userId === null || typeof resolveRoles !== 'function') return [];

    try {
      return (await resolveRoles(userId)) ?? [];
    } catch (cause) {
      logger.warn("rôles d'un membre illisibles, exclusion par rôle ignorée", {
        user: userId,
        error: cause,
      });

      return [];
    }
  }

  /** Ce compte est-il exclu, par lui-même ou par l'un de ses rôles ? */
  async function isExcludedUser(userId) {
    if (userId === null) return false;
    if (isSelf(userId)) return true;
    if (list('users').includes(userId)) return true;

    const excluded = list('roles');

    if (excluded.length === 0) return false;

    const roles = await rolesOf(userId);

    return roles.some((role) => excluded.includes(role));
  }

  /**
   * Le sujet de l'événement : de qui parle-t-on quand personne n'agit ?
   *
   * `targetId` d'abord — c'est le membre que l'événement concerne. À défaut,
   * l'auteur du message, seul renseigné sur une suppression dont on ignore la
   * cible.
   */
  const subjectOf = (event) => event.targetId ?? event.content?.authorId ?? null;

  /**
   * Raccourci, et le seul autorisé : une modification d'un message du bot.
   *
   * Seul l'auteur peut modifier son message, donc l'acteur est connu sans
   * requête ni corrélation. Écarter tout de suite évite une écriture inutile et
   * la boucle qu'elle amorcerait.
   *
   * **Ne vaut PAS pour `message_delete`** : un modérateur qui supprime un
   * message du bot doit être journalisé, le tableau du §4 l'exige. La différence
   * n'est pas une subtilité — c'est la ligne entre « le bot se tait sur
   * lui-même » et « le bot cache les actions du staff ».
   */
  const isBotSelfEdit = (event) =>
    event.eventType === 'message_edit' && isSelf(event.content?.authorId ?? null);

  /**
   * Faut-il ignorer cet événement ?
   *
   * @param {object} event événement normalisé
   * @param {{ actorId: string|null }} attribution verdict de la corrélation
   * @returns {Promise<boolean>}
   */
  async function isExcluded(event, { actorId = null } = {}) {
    // Un tiers a été désigné : c'est LUI que l'on juge, et rien d'autre. Un
    // modérateur non exclu est journalisé même dans un salon exclu, même sur un
    // message d'un compte exclu.
    if (actorId !== null) return isExcludedUser(actorId);

    // Personne n'agit : l'événement est l'activité ordinaire de son sujet.
    if (await isExcludedUser(subjectOf(event))) return true;

    // Le salon ne compte QUE dans ce cas. C'est ce qui distingue « un membre
    // écrit dans un salon exclu » de « un modérateur supprime un message dans un
    // salon exclu ».
    return event.channelId !== null && list('channels').includes(event.channelId);
  }

  return {
    isExcluded,
    isBotSelfEdit,

    /** Le câblage a-t-il fourni l'identité du bot ? Sert au diagnostic. */
    get hasSelfId() {
      return selfId() !== null;
    },

    /** Types sur lesquels le raccourci peut s'appliquer. Pour les tests. */
    get selfEditTypes() {
      return MESSAGE_EVENTS.filter((type) => type === 'message_edit');
    },
  };
}
