import { AppError } from '../errors/app-error.js';

import { clamp, EMBED_LIMITS } from './limits.js';

/**
 * Moteur de rendu des embeds (socle §9).
 *
 * Tout message du bot passe par un gabarit d'`embeds.yml`. Aucun texte ni
 * couleur n'est écrit ici : le moteur assemble, il ne rédige pas.
 *
 * Il produit un objet conforme à l'API Discord plutôt qu'un `EmbedBuilder` :
 * discord.js accepte l'un comme l'autre, et un objet brut se teste sans
 * connexion ni dépendance à la bibliothèque.
 */

const HEX = /^#([0-9a-fA-F]{6})$/;

/**
 * @param {object} options
 * @param {object} options.config configuration, pour les gabarits et les textes
 * @param {object} options.logger journalisation injectée
 */
export function createEmbedEngine({ config, logger }) {
  /**
   * Convertit une couleur de gabarit en entier, seule forme que Discord accepte.
   *
   * La valeur est soit une clé de la palette d'`embeds.yml`, soit un
   * hexadécimal direct. La validation croisée a déjà vérifié au démarrage que
   * les clés nommées existent ; ce qui reste ici est le cas d'une couleur
   * saisie à l'exécution, par la commande d'embeds de la phase 5.
   */
  function resolveColor(value) {
    const direct = HEX.exec(value);
    if (direct !== null) return Number.parseInt(direct[1], 16);

    const palette = config.colors ?? {};
    const named = palette[value];

    if (named === undefined) {
      logger.error('couleur absente de la palette', { color: value });

      // La marque est le repli le moins surprenant : un embed sans couleur
      // s'affiche avec une barre grise, indistinguable d'un message d'un autre
      // bot.
      return resolveColor(palette.brand ?? '#000000');
    }

    return resolveColor(named);
  }

  /** Applique une limite de plateforme en signalant la coupure. */
  function fit(text, limit, field, template) {
    const { text: kept, truncated } = clamp(text, limit);

    if (truncated) {
      logger.warn('texte tronqué pour tenir dans un embed', {
        template,
        field,
        limit,
        length: text.length,
      });
    }

    return kept;
  }

  return {
    /**
     * Rend un gabarit d'`embeds.yml`.
     *
     * Les textes passent par `config.text()`, qui consomme le `missing` du
     * moteur de substitution et le journalise : une variable non fournie laisse
     * son marqueur visible et produit une entrée, jamais un affichage vide.
     *
     * @param {string} name nom du gabarit
     * @param {Record<string, unknown>} [variables]
     * @returns {object} données d'embed, telles que discord.js les accepte
     */
    render(name, variables = {}) {
      const template = config.template(name);

      if (template === undefined) {
        // Le nom du gabarit est écrit dans le code : son absence est un défaut
        // de programmation, pas une erreur d'exploitation.
        throw new AppError(`gabarit d'embed absent : ${name}`, {
          code: 'embed_template_missing',
          context: { template: name },
          expected: false,
        });
      }

      const embed = {
        color: resolveColor(template.color),
        description: fit(
          config.text(template.description_key, variables),
          EMBED_LIMITS.description,
          'description',
          name,
        ),
      };

      if (template.title_key !== undefined) {
        embed.title = fit(
          config.text(template.title_key, variables),
          EMBED_LIMITS.title,
          'title',
          name,
        );
      }

      const footer = config.footer;

      if (footer !== null) {
        embed.footer = { text: fit(footer.text, EMBED_LIMITS.footer, 'footer', name) };

        // Horodatage natif Discord : la plateforme l'affiche dans le fuseau de
        // chaque lecteur, `bot.timezone` n'a donc pas prise dessus. Voir la
        // note du §9 pour les horodatages que nous écrivons nous-mêmes.
        if (footer.timestamp) embed.timestamp = new Date().toISOString();
      }

      return embed;
    },

    /**
     * Vérifie qu'un ensemble d'embeds tient dans le budget d'un message.
     *
     * Discord rejette le message entier au-delà, sans indiquer lequel déborde.
     *
     * **MUETTE, délibérément.** C'est une MESURE, pas une alerte : elle rend le
     * verdict et la longueur, l'appelant a tout ce qu'il faut pour décider et
     * pour journaliser ce que sa décision signifie.
     *
     * Elle a journalisé un avertissement, et c'était un défaut de contrat : une
     * fonction ne peut pas être à la fois un prédicat consulté en boucle et une
     * alerte. Le premier appelant qui s'en est servi pour découper un lot
     * produisait un avertissement par coupure — un fonctionnement parfaitement
     * sain émettant le signal réservé aux anomalies, qui aurait noyé un vrai
     * dépassement le jour où il serait survenu.
     *
     * @returns {{ ok: boolean, length: number }}
     */
    fits(embeds) {
      const length = embeds.reduce((sum, embed) => sum + measure(embed), 0);

      return { ok: length <= EMBED_LIMITS.total, length };
    },
  };
}

/** Somme des textes d'un embed, telle que Discord la compte. */
function measure(embed) {
  const parts = [embed.title, embed.description, embed.footer?.text, embed.author?.name];
  const fields = embed.fields ?? [];

  return (
    parts.reduce((sum, part) => sum + (part?.length ?? 0), 0) +
    fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

export { EMBED_LIMITS } from './limits.js';
