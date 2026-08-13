import { EPHEMERAL } from '../discord/flags.js';
import { AppError, isExpected, PermissionDeniedError } from '../errors/app-error.js';

import { isAllowed, roleIdsOf } from './permissions.js';

/**
 * Registre des commandes slash (socle §8).
 *
 * Commandes slash uniquement, enregistrées au niveau du serveur : la
 * propagation y est instantanée, contre jusqu'à une heure en global.
 */

/** Contrainte Discord sur le nom d'une commande. */
const COMMAND_NAME = /^[a-z0-9_-]{1,32}$/;

export function createCommandRegistry({ config, logger, embeds }) {
  /** @type {Map<string, object>} */
  const commands = new Map();

  /**
   * Inscrit les commandes d'un module.
   *
   * Une commande déclare `description_key` et non une description : le texte
   * est vu par tous les membres dans l'interface de Discord, il vient donc de
   * `messages.yml`.
   */
  function register(owner, list = []) {
    for (const command of list) {
      const fault = (message) => {
        throw new AppError(`commande « ${command?.name} » de ${owner} : ${message}`, {
          code: 'command_invalid',
          context: { owner, command: command?.name },
          expected: false,
        });
      };

      if (typeof command?.name !== 'string' || !COMMAND_NAME.test(command.name)) {
        fault('nom attendu : 1 à 32 caractères, minuscules, chiffres, tiret ou tiret bas');
      }

      if (typeof command.description_key !== 'string') {
        fault('« description_key » manquante — le texte vient de messages.yml');
      }

      if (typeof command.execute !== 'function') fault('« execute » doit être une fonction');

      if (commands.has(command.name)) {
        const held = commands.get(command.name);
        fault(`déjà fournie par ${held.owner}`);
      }

      commands.set(command.name, { ...command, owner });
    }
  }

  /**
   * Commandes sans entrée dans `config.yml`.
   *
   * À contrôler au démarrage : sans configuration, une commande est refusée à
   * tous, et la découvrir à la première utilisation est plusieurs jours trop
   * tard.
   */
  function unconfigured() {
    return [...commands.keys()].filter(
      (name) => config.get(`commands.${name}.allowed_roles`, undefined) === undefined,
    );
  }

  /** Charge utile d'enregistrement auprès de l'API Discord. */
  function toJSON() {
    return [...commands.values()].map((command) => ({
      name: command.name,
      description: config.text(command.description_key),
      ...(command.options ? { options: command.options.map(renderOption) } : {}),
    }));
  }

  /** Une option porte elle aussi un texte affiché, donc une clé. */
  function renderOption(option) {
    const { description_key: key, options: nested, ...rest } = option;

    return {
      ...rest,
      description: config.text(key),
      ...(nested ? { options: nested.map(renderOption) } : {}),
    };
  }

  /**
   * Route une interaction : permissions, exécution, réponse d'échec.
   *
   * Ne lève jamais. Une commande qui échoue doit répondre quelque chose — une
   * interaction sans réponse laisse « L'application ne répond pas » à l'écran.
   */
  async function handle(interaction, context = {}) {
    const command = commands.get(interaction.commandName);

    if (command === undefined) {
      // Commande enregistrée auprès de Discord mais disparue du code : le
      // décalage se résorbe au prochain déploiement.
      logger.error('commande inconnue', { command: interaction.commandName });
      await deny(interaction, new PermissionDeniedError(interaction.commandName));
      return;
    }

    const allowedRoles = config.get(`commands.${command.name}.allowed_roles`, undefined);

    if (!isAllowed(allowedRoles, roleIdsOf(interaction.member))) {
      // Refus : éphémère au demandeur seul, aucune trace dans les salons de
      // logs (socle §8.3).
      logger.info('commande refusée', {
        command: command.name,
        user: interaction.user?.id,
        configured: allowedRoles !== undefined,
      });

      await deny(interaction, new PermissionDeniedError(command.name, { user: interaction.user?.id }));
      return;
    }

    try {
      await command.execute(interaction, context);
    } catch (cause) {
      const error = cause instanceof AppError ? cause : null;

      logger.error('commande en échec', {
        command: command.name,
        user: interaction.user?.id,
        expected: isExpected(cause),
        error: cause,
      });

      await deny(interaction, error ?? new AppError('commande en échec', {
        code: 'command_failed',
        template: 'command_failed',
        expected: false,
      }));
    }
  }

  /** Répond au seul demandeur avec le gabarit porté par l'erreur. */
  async function deny(interaction, error) {
    try {
      const embed = embeds.render(error.template ?? 'command_failed', error.variables);
      const payload = { embeds: [embed], flags: EPHEMERAL };

      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch (cause) {
      // L'interaction a expiré, ou le gabarit manque. Rien de plus à tenter :
      // insister produirait une seconde erreur au même endroit.
      logger.error('réponse impossible à une interaction', {
        command: interaction.commandName,
        error: cause,
      });
    }
  }

  return {
    register,
    unconfigured,
    toJSON,
    handle,

    get size() {
      return commands.size;
    },

    has: (name) => commands.has(name),
    names: () => [...commands.keys()],
  };
}

export { isAllowed, roleIdsOf } from './permissions.js';
