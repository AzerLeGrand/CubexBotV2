import { fileURLToPath } from 'node:url';

import { Client, GatewayIntentBits } from 'discord.js';

import { createCommandRegistry } from './core/commands/index.js';
import { createReloadCommand } from './core/commands/reload.js';
import { CapabilityRegistry } from './core/config/capabilities.js';
import { verifyDiscordRefs } from './core/config/discord-refs.js';
import { ConfigValidationError, formatErrors } from './core/config/errors.js';
import { loadEnv } from './core/config/env.js';
import { Configuration } from './core/config/index.js';
import { createDatabase } from './core/database/index.js';
import { CORE_OWNER } from './core/database/migrations.js';
import { createEmbedEngine } from './core/embeds/index.js';
import { createErasureRegistry } from './core/erasure/index.js';
import { createShutdown } from './core/errors/handler.js';
import { loadModules, migrationSources } from './core/loader/index.js';
import { createLogger } from './core/logging/index.js';
import { createPurgeRegistry } from './core/purge/index.js';
import { createMinecraftBridge } from './minecraft/index.js';
import { fromRoot } from './utils/paths.js';

/**
 * Assemblage du bot.
 *
 * L'ordre est contraint de bout en bout : la configuration précède le logger,
 * dont le niveau vient d'elle ; la base précède les modules, dont les migrations
 * s'appliquent dessus ; la connexion précède la vérification des références, que
 * seule l'API peut trancher.
 *
 * Les fermetures s'inscrivent dans l'ordre d'ouverture et se déroulent à
 * l'envers : les journaux, inscrits d'office en premier, partent en dernier et
 * peuvent relater les fermetures précédentes.
 */

/** Phase 0 : le fonctionnement de base ne demande rien d'autre (socle §12). */
const INTENTS = [GatewayIntentBits.Guilds];

/** Migrations du noyau, propriétaire `core`. */
const CORE_MIGRATIONS = { owner: CORE_OWNER, directory: fromRoot('migrations') };

export async function bootstrap() {
  // ---------------------------------------------------------------------
  // 1. Secrets et configuration — avant tout, et sans journalisation
  //    possible : le logger se règle depuis ce qui est lu ici.
  // ---------------------------------------------------------------------
  const { env, errors: envErrors } = loadEnv();

  if (envErrors.length > 0) {
    process.stderr.write(`${formatErrors(envErrors, 'Secrets manquants')}\n`);
    return process.exit(1);
  }

  const config = new Configuration();

  try {
    config.load();
  } catch (cause) {
    if (!(cause instanceof ConfigValidationError)) throw cause;

    // Un bot arrêté vaut mieux qu'un bot tournant sur une configuration
    // incohérente (socle §5.4).
    process.stderr.write(`${formatErrors(cause.errors, cause.summary)}\n`);
    return process.exit(1);
  }

  // ---------------------------------------------------------------------
  // 2. Journalisation, puis injection dans ce qui a déjà parlé
  // ---------------------------------------------------------------------
  const logger = createLogger({
    level: config.get('logging.level'),
    directory: fromRoot(config.get('logging.directory')),
    filePrefix: config.get('logging.file_prefix'),
    retentionDays: config.get('logging.retention_days'),
    timezone: config.get('bot.timezone'),
    console: env.NODE_ENV === 'development',
  });

  // Rejoue ce que la configuration a dit avant que le logger n'existe.
  config.setLogger(logger.forModule('config'));

  const shutdown = createShutdown({ logger });
  const uninstall = shutdown.install();

  logger.info('démarrage', { env: env.NODE_ENV, node: process.version });

  // ---------------------------------------------------------------------
  // 3. Base de données et migrations
  // ---------------------------------------------------------------------
  const database = createDatabase({
    file: config.get('database.file'),
    busyTimeoutMs: config.get('database.busy_timeout_ms'),
    logger: logger.forModule('database'),
    shutdown,
  });

  const modules = await loadModules({ logger: logger.forModule('loader') });

  database.migrate([CORE_MIGRATIONS, ...migrationSources(modules)]);

  // ---------------------------------------------------------------------
  // 4. Registres du noyau
  // ---------------------------------------------------------------------
  const embeds = createEmbedEngine({ config, logger: logger.forModule('embeds') });
  const capabilities = new CapabilityRegistry();
  const minecraft = createMinecraftBridge({
    enabled: config.get('minecraft.enabled'),
    logger: logger.forModule('minecraft'),
  });

  const purge = createPurgeRegistry({
    database,
    config,
    logger: logger.forModule('purge'),
    shutdown,
  });

  const erasure = createErasureRegistry({ database, logger: logger.forModule('erasure') });
  const commands = createCommandRegistry({ config, logger: logger.forModule('commands'), embeds });

  const client = new Client({ intents: INTENTS });

  shutdown.register('discord', () => client.destroy());

  /** Manifestes de capacités, enrichis du module qui les déclare. */
  const declarations = modules.flatMap((module) =>
    module.capabilities.map((declaration) => ({ ...declaration, module: module.name })),
  );

  const verifyRefs = async () => {
    const guild = await client.guilds.fetch(config.get('bot.guild_id'));

    return verifyDiscordRefs({
      guild,
      config: config.raw,
      declarations,
      capabilities,
      logger: logger.forModule('config'),
    });
  };

  commands.register(CORE_OWNER, [
    createReloadCommand({
      config,
      embeds,
      logger: logger.forModule('commands'),
      // Les identifiants ont pu changer : les références se revérifient sur la
      // nouvelle configuration avant que la confirmation ne parte.
      afterReload: () => verifyRefs(),
    }),
  ]);

  // ---------------------------------------------------------------------
  // 5. Modules : déclarations puis initialisation
  // ---------------------------------------------------------------------
  const context = {
    config,
    database,
    logger,
    embeds,
    capabilities,
    purge,
    erasure,
    commands,
    minecraft,
    client,
    shutdown,
  };

  for (const module of modules) {
    purge.register(module.name, module.retention);
    erasure.register(module.name, module.erasure);
    commands.register(module.name, module.commands);
  }

  for (const module of modules) {
    if (module.init !== null) await module.init({ ...context, module: module.name });
  }

  // Rapport au démarrage, jamais à la première utilisation : une commande sans
  // configuration est refusée à tous, et le découvrir en production est
  // plusieurs jours trop tard.
  const unconfigured = commands.unconfigured();

  if (unconfigured.length > 0) {
    logger.error('commandes sans entrée dans config.yml, elles seront refusées', {
      commands: unconfigured,
    });
  }

  // ---------------------------------------------------------------------
  // 6. Connexion, puis ce qui n'est possible qu'ensuite
  // ---------------------------------------------------------------------
  client.once('clientReady', async () => {
    try {
      const guild = await client.guilds.fetch(config.get('bot.guild_id'));

      // Enregistrement au niveau du serveur : propagation instantanée, contre
      // jusqu'à une heure en global (socle §8.1).
      await guild.commands.set(commands.toJSON());

      const refs = await verifyRefs();

      logger.info('bot prêt', {
        guild: guild.name,
        commands: commands.size,
        modules: modules.map((module) => module.name),
        capabilities_disabled: refs.disabled,
        modules_disabled: refs.disabledModules,
      });

      purge.start();
    } catch (cause) {
      logger.error('initialisation après connexion en échec', { error: cause });
    }
  });

  client.on('interactionCreate', (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    // handle() ne lève jamais : une interaction sans réponse laisse
    // « L'application ne répond pas » à l'écran.
    void commands.handle(interaction, context);
  });

  client.on('error', (error) => logger.error('erreur du client Discord', { error }));

  await client.login(env.DISCORD_TOKEN);

  return { config, logger, database, client, shutdown, uninstall, context };
}

// Démarre uniquement quand ce fichier est le point d'entrée : un import depuis
// un test ne doit pas connecter le bot.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bootstrap();
}
