import { ApplicationCommandOptionType } from 'discord.js';

import { EPHEMERAL } from '../../core/discord/flags.js';

import { OUTCOMES } from './constants.js';

/**
 * Commande de déblocage.
 *
 * Sans elle, un membre bloqué le reste définitivement : le seul recours serait
 * une modification manuelle de la base.
 *
 * Aucune logique ici — le moteur décide, ce fichier traduit un résultat en
 * gabarit. Rien ne part vers Discord ni vers le membre : la journalisation des
 * actions de modération est le sujet de la phase 3, et le membre reclique, ça
 * marche.
 *
 * **Limite assumée** : quand le module est désactivé — salon de vérification
 * supprimé, rôle `Member` disparu — le routeur du noyau répond
 * `feature_unavailable` à cette commande comme au reste, et le staff ne peut
 * donc pas débloquer pendant que la configuration est cassée. C'est cohérent
 * avec le socle et sans conséquence réelle : personne ne peut se vérifier dans
 * cet état, donc débloquer n'aurait servi à rien. Ce n'est pas un oubli.
 */

/** Nom de l'option, tel qu'il apparaît dans l'interface de Discord. */
const OPTION_MEMBER = 'member';

/** Résultat du moteur vers gabarit d'`embeds.yml`. */
const TEMPLATES = Object.freeze({
  [OUTCOMES.unblocked]: 'verification_unblocked',
  [OUTCOMES.counter_reset]: 'verification_counter_reset',
  [OUTCOMES.nothing_to_do]: 'verification_nothing_to_do',
});

export function createCommands({ engine }) {
  return [
    {
      name: 'unblock',
      description_key: 'commands.unblock.description',

      options: [
        {
          // Type `user` et non une chaîne d'identifiant : Discord valide la
          // cible, offre son autocomplétion, et évite la faute de frappe sur
          // dix-neuf chiffres.
          type: ApplicationCommandOptionType.User,
          name: OPTION_MEMBER,
          description_key: 'commands.unblock.option_member',
          required: true,
        },
      ],

      async execute(interaction, ctx) {
        // `getUser` et JAMAIS `getMember`. Le blocage persiste par identifiant,
        // y compris après un départ — c'est même sa raison d'être, un script
        // qui quitte et rejoint en boucle ne doit pas se débloquer tout seul.
        //
        // Or discord.js alimente `member` depuis `resolved.members`, que
        // Discord n'envoie QUE si la personne est encore sur le serveur, tandis
        // que `user` vient de `resolved.users`, toujours présent. `getMember()`
        // rendrait donc `null` dans le seul cas où cette commande est vraiment
        // utile.
        const target = interaction.options.getUser(OPTION_MEMBER, true);

        const result = engine().unblock({
          userId: target.id,
          actorId: interaction.user.id,
        });

        await interaction.reply({
          embeds: [ctx.embeds.render(TEMPLATES[result.outcome], { member: `<@${target.id}>` })],
          flags: EPHEMERAL,
        });
      },
    },
  ];
}
