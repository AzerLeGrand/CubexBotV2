import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';

import { roleIdsOf } from '../../core/commands/permissions.js';
import { encodeCustomId } from '../../core/components/index.js';
import { EPHEMERAL } from '../../core/discord/flags.js';
import { AppError } from '../../core/errors/app-error.js';

import { ACTIONS, CODE_FIELD, OUTCOMES } from './constants.js';
import { alertExhausted, alertRoleFailure, logVerified } from './notify.js';

/**
 * Les trois composants du parcours de vérification.
 *
 * **Aucune logique métier ici.** Les tentatives, le blocage, le tirage, la
 * comparaison et le rendu appartiennent au moteur : ce fichier traduit un
 * résultat en gabarit, et une interaction en appel. Si un `attempts` ou une
 * comparaison de code apparaissait ici, c'est que la frontière aurait fui.
 *
 * Les trois sont `permission: 'public'`, et c'est le cas qui a justifié que le
 * routeur du noyau refuse tout défaut : un membre non vérifié ne porte AUCUN
 * rôle, donc fermer par défaut rendrait ces boutons muets pour exactement le
 * public qu'ils visent. Ouvrir par défaut aurait été pire ailleurs — l'auteur
 * tranche, pour chaque composant.
 */

/** Nom du fichier joint, référencé par l'embed. Technique, jamais lu par personne. */
const CAPTCHA_FILE = 'captcha.png';

/**
 * Échec d'attribution du rôle, distingué de toute autre défaillance.
 *
 * Sans ce type, une panne de base de données remonterait par le même chemin et
 * serait rapportée au staff comme un problème de hiérarchie de rôles.
 */
class RoleGrantError extends AppError {
  constructor(cause, context) {
    super(`attribution du rôle de vérification impossible : ${cause.message}`, {
      code: 'verification_role_grant_failed',
      context,
      cause,
      expected: false,
    });
  }
}

/** Le membre porte-t-il déjà le rôle ? Seule information Discord que le moteur reçoit. */
const hasMemberRole = (interaction, ctx) =>
  roleIdsOf(interaction.member).includes(ctx.config.get('verification.member_role_id'));

/** Résultat du moteur vers gabarit d'`embeds.yml`. */
const TEMPLATES = Object.freeze({
  [OUTCOMES.success]: 'verification_success',
  [OUTCOMES.wrong]: 'verification_wrong_code',
  [OUTCOMES.expired]: 'verification_expired',
  [OUTCOMES.blocked]: 'verification_blocked',
  [OUTCOMES.already_verified]: 'verification_already_verified',
});

/** Variables attendues par les textes du lot 1. */
const variablesFor = (result) => (result.outcome === OUTCOMES.wrong ? { remaining: result.remaining } : {});

export function createComponents({ engine }) {
  /**
   * Bouton du message d'accueil.
   *
   * **Défère puis édite.** Le rendu de l'image est synchrone et la fenêtre de
   * réponse initiale est de trois secondes : l'accusé la porte à quinze
   * minutes. C'est l'exact opposé du bouton suivant, et les deux sont imposés
   * par la plateforme, pas choisis.
   */
  const start = {
    action: ACTIONS.start,
    permission: 'public',
    async execute(interaction, ctx) {
      await interaction.deferReply({ flags: EPHEMERAL });

      const result = engine().begin({
        userId: interaction.user.id,
        hasRole: hasMemberRole(interaction, ctx),
      });

      if (result.outcome !== OUTCOMES.issued) {
        await interaction.editReply({
          embeds: [ctx.embeds.render(TEMPLATES[result.outcome], variablesFor(result))],
        });

        return;
      }

      const minutes = Math.round(ctx.config.get('verification.challenge.ttl_seconds') / 60);

      const open = new ButtonBuilder()
        .setCustomId(encodeCustomId(ctx.module, ACTIONS.open))
        .setLabel(ctx.config.text('verification.buttons.enter_code'))
        .setStyle(ButtonStyle.Primary);

      await interaction.editReply({
        embeds: [
          {
            ...ctx.embeds.render('verification_challenge', { minutes }),
            // L'image est jointe et référencée par l'embed : une modale ne peut
            // pas contenir d'image, d'où ces deux étapes.
            image: { url: `attachment://${CAPTCHA_FILE}` },
          },
        ],
        files: [{ attachment: result.attachment, name: CAPTCHA_FILE }],
        components: [new ActionRowBuilder().addComponents(open)],
      });
    },
  };

  /**
   * Bouton « Entrer le code ».
   *
   * **`showModal()` est la PREMIÈRE réponse**, sans aucun accusé préalable :
   * Discord refuse d'ouvrir une modale sur une interaction déjà accusée. C'est
   * parce que le routeur du noyau n'accuse jamais réception à la place du
   * module que ce chemin reste possible.
   */
  const open = {
    action: ACTIONS.open,
    permission: 'public',
    async execute(interaction, ctx) {
      const field = new TextInputBuilder()
        .setCustomId(CODE_FIELD)
        .setLabel(ctx.config.text('verification.modal.field_label'))
        .setPlaceholder(ctx.config.text('verification.modal.placeholder'))
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const modal = new ModalBuilder()
        .setCustomId(encodeCustomId(ctx.module, ACTIONS.submit))
        .setTitle(ctx.config.text('verification.modal.title'))
        .addComponents(new ActionRowBuilder().addComponents(field));

      await interaction.showModal(modal);
    },
  };

  /**
   * Soumission de la modale.
   *
   * Défère, puis appelle le moteur en lui confiant l'attribution du rôle :
   * celle-ci s'exécute AVANT que la réussite ne soit écrite, et son échec
   * annule tout. L'inverse laisserait un membre sans rôle et sans ligne d'état,
   * invité à recommencer un captcha qu'il vient de résoudre.
   */
  const submit = {
    action: ACTIONS.submit,
    permission: 'public',
    async execute(interaction, ctx) {
      await interaction.deferReply({ flags: EPHEMERAL });

      const userId = interaction.user.id;
      let result;

      try {
        result = await engine().submit({
          userId,
          hasRole: hasMemberRole(interaction, ctx),
          input: interaction.fields.getTextInputValue(CODE_FIELD),
          onAccepted: () => grantRole(interaction, ctx),
        });
      } catch (error) {
        if (!(error instanceof RoleGrantError)) throw error;

        // Aucune écriture en base n'a eu lieu : le membre recliquera une fois
        // le serveur réparé, et retombera sur la même image.
        await alertRoleFailure(ctx, userId);
        await interaction.editReply({ embeds: [ctx.embeds.render('verification_role_failed')] });

        return;
      }

      await interaction.editReply({
        embeds: [ctx.embeds.render(TEMPLATES[result.outcome], variablesFor(result))],
      });

      if (result.outcome === OUTCOMES.success) await logVerified(ctx, userId);

      // À l'épuisement UNIQUEMENT : un membre déjà bloqué qui reclique ne
      // déclenche rien.
      if (result.outcome === OUTCOMES.blocked && result.justBlocked === true) {
        await alertExhausted(ctx, userId);
      }
    },
  };

  return [start, open, submit];
}

/** Attribue le rôle, en distinguant son échec de tout autre. */
async function grantRole(interaction, ctx) {
  const roleId = ctx.config.get('verification.member_role_id');

  try {
    await interaction.member.roles.add(roleId);
  } catch (cause) {
    // Hiérarchie, permission retirée, rôle supprimé : le serveur est à réparer,
    // et personne ne peut entrer tant que ça dure.
    throw new RoleGrantError(cause, { user: interaction.user.id, role: roleId });
  }
}

export { RoleGrantError };
