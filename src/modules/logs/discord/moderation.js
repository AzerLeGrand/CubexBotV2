import { AutoModerationActionType, AutoModerationRuleTriggerType } from 'discord.js';

import { ACTOR_CONFIDENCE, EVENT_SOURCE } from '../constants.js';
import { createEmitter } from './emit.js';

/**
 * Écouteurs de la famille « modération » (spec §2).
 *
 * Bannissement, levée de bannissement, déclenchement d'une règle AutoMod.
 *
 * **L'expulsion n'a pas d'écouteur, et n'en aura jamais.** Discord n'émet aucun
 * signal distinct : une expulsion arrive en `guildMemberRemove`, exactement
 * comme un départ volontaire, et seule la corrélation les sépare. Elle vit donc
 * dans `members.js`, où le signal arrive — voir `TYPE_PROMOTIONS`.
 *
 * **L'exclusion temporaire non plus.** Elle arrive en `guildMemberUpdate` et
 * reste dans `members.js` pour la même raison : c'est la famille du SIGNAL, pas
 * celle du salon de destination, qui décide du fichier. Le salon vient de
 * `config.yml` et peut changer sans toucher au code.
 *
 * **Aucun écouteur ne produit `probable`** : cette confiance appartient à la
 * corrélation seule.
 */

/**
 * Nom d'une valeur d'énumération, ou la valeur telle quelle.
 *
 * Les énumérations de discord.js portent leur correspondance inverse : lues par
 * leur entier, elles rendent le nom. On écrit le NOM dans `data` et jamais
 * l'entier, pour la même raison que `AUDIT_ACTIONS` : une renumérotation de la
 * plateforme rendrait fausses toutes les lignes déjà écrites, et le journal
 * n'aurait plus aucun moyen de dire ce qu'il a enregistré.
 *
 * Une valeur inconnue — un type ajouté par Discord après cette version de la
 * bibliothèque — est conservée sous sa forme brute. Écrire « 7 » est laid, mais
 * c'est vrai, et cela laisse de quoi comprendre. Rendre `null` effacerait
 * l'information.
 */
const nameOf = (enumeration, value) =>
  value === null || value === undefined ? null : (enumeration[value] ?? String(value));

export function createModerationListeners({ recorder }) {
  const { emit } = createEmitter({ recorder });

  /**
   * Bannissement et levée : même forme, deux types.
   *
   * Aucun acteur n'est fourni. La passerelle ne livre que le membre visé — c'est
   * le journal d'audit qui porte le modérateur, et la corrélation l'y trouvera
   * en `probable`.
   *
   * **`reason` n'est pas renseigné en direct** : la charge utile
   * `GUILD_BAN_ADD` ne porte que le serveur et l'utilisateur, et l'objet est
   * partiel. La raison vit dans le journal d'audit, et c'est la corrélation qui
   * l'en tire pour la ranger dans `data`.
   *
   * La clé est tout de même lue ici, pour le cas où la structure vient
   * d'ailleurs qu'à la passerelle — un objet complet, déjà chargé. Ce qu'on lit
   * alors accompagne l'événement lui-même, donc c'est un FAIT, et le recorder
   * lui laisse la priorité sur la raison corrélée, qui n'est qu'une déduction.
   */
  const banEvent = (type) => (ctx, ban) => {
    const reason = typeof ban.reason === 'string' && ban.reason.length > 0 ? ban.reason : null;

    return emit({
      type,
      occurredAt: new Date(),
      actorId: null,
      actorConfidence: ACTOR_CONFIDENCE.unknown,
      targetId: ban.user.id,
      channelId: null,
      source: EVENT_SOURCE.live,
      // `data` reste vide sans raison : une clé à `null` ferait afficher une
      // ligne « Raison : — » sur chaque bannissement, c'est-à-dire toujours.
      data: reason === null ? {} : { reason },
    });
  };

  return [
    { name: 'guildBanAdd', execute: banEvent('member_ban') },
    { name: 'guildBanRemove', execute: banEvent('member_unban') },
    {
      /**
       * Déclenchement d'une règle AutoMod.
       *
       * **L'événement se décrit lui-même** : la passerelle livre la règle,
       * l'action et le membre. Aucune corrélation n'est possible ni utile — il
       * n'y a pas d'auteur humain à chercher, et `AUDIT_ACTIONS` déclare une
       * liste vide pour ce type.
       *
       * L'acteur est l'auteur du message déclencheur, en `certain` : c'est lui
       * qui a agi, la règle n'a fait que réagir. Il est aussi la cible — le seul
       * membre que l'événement concerne — et les deux champs portent donc le
       * même identifiant sans que ce soit une redondance.
       *
       * `matchedKeyword` est le mot CONFIGURÉ DANS LA RÈGLE, pas le message du
       * membre. `matchedContent` — l'extrait du message, lui — n'est
       * délibérément pas repris : c'est du contenu de membre, il relève de
       * `log_message_content` et de sa rétention courte, et le recopier dans
       * `data` le ferait survivre soixante jours à sa propre purge.
       */
      name: 'autoModerationActionExecution',
      execute: (ctx, execution) =>
        emit({
          type: 'automod_action',
          occurredAt: new Date(),
          actorId: execution.userId,
          actorConfidence: ACTOR_CONFIDENCE.certain,
          targetId: execution.userId,
          channelId: execution.channelId ?? null,
          source: EVENT_SOURCE.live,
          data: {
            rule_id: execution.ruleId,
            trigger: nameOf(AutoModerationRuleTriggerType, execution.ruleTriggerType),
            action: nameOf(AutoModerationActionType, execution.action?.type),
            keyword: execution.matchedKeyword ?? null,
          },
        }),
    },
  ];
}
