import { formatErrorsWithin } from '../config/errors.js';
import { EPHEMERAL } from '../discord/flags.js';
import { EMBED_LIMITS } from '../embeds/limits.js';

/**
 * Commande de rechargement à chaud (socle §5.6).
 *
 * Seule commande du noyau. Sa configuration est obligatoire dans `config.yml` —
 * `commands.reload.allowed_roles` — et le schéma la rend inévitable.
 */

/**
 * @param {object} options
 * @param {object} options.config   configuration, qui porte `reload()`
 * @param {object} options.embeds   moteur de rendu
 * @param {object} options.logger
 * @param {() => Promise<void>} [options.afterReload]
 *   rejoue ce qui dépend de la configuration — la vérification des références
 *   Discord, notamment, qui doit repartir sur les nouveaux identifiants.
 */
export function createReloadCommand({ config, embeds, logger, afterReload = null }) {
  return {
    name: 'reload',
    description_key: 'commands.reload.description',

    async execute(interaction) {
      const actor = interaction.user?.id ?? null;
      const result = config.reload({ actor });

      if (result.ok) {
        // La nouvelle configuration est en place : ce qui en dépend doit être
        // rejoué avant de confirmer, sinon la confirmation devancerait l'effet.
        if (afterReload !== null) {
          try {
            await afterReload();
          } catch (cause) {
            logger.error('rechargement appliqué mais reprise incomplète', {
              actor,
              error: cause,
            });
          }
        }

        await interaction.reply({
          embeds: [embeds.render('config_reloaded')],
          flags: EPHEMERAL,
        });

        return;
      }

      // Le corps technique est tronqué AVANT substitution : l'injecter d'abord
      // ferait dépasser la limite de description sans que rien ne le rattrape.
      const enveloppe = config.text('config.reload_failed.description', {
        count: result.errors.length,
        errors: '',
      });

      const { text, shown, total, truncated } = formatErrorsWithin(
        result.errors,
        EMBED_LIMITS.description - enveloppe.length,
      );

      const embed = embeds.render('config_reload_failed', {
        count: total,
        errors: text,
      });

      if (truncated) {
        embed.description += `\n${config.text('config.reload_failed.truncated', { shown, count: total })}`;
      }

      await interaction.reply({ embeds: [embed], flags: EPHEMERAL });
    },
  };
}
