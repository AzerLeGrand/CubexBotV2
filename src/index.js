import { fileURLToPath } from 'node:url';

import { Client } from 'discord.js';

import { createCommandRegistry } from './core/commands/index.js';
import { createReloadCommand } from './core/commands/reload.js';
import { createComponentRegistry, routeInteraction } from './core/components/index.js';
import { CapabilityRegistry } from './core/config/capabilities.js';
import { verifyDiscordRefs } from './core/config/discord-refs.js';
import { ConfigValidationError, formatErrors } from './core/config/errors.js';
import { loadEnv } from './core/config/env.js';
import { Configuration } from './core/config/index.js';
import { buildConfigSchema, CORE_SECTION_NAMES } from './core/config/schema/core.schema.js';
import { createDatabase } from './core/database/index.js';
import { CORE_OWNER } from './core/database/migrations.js';
import { createEmbedEngine } from './core/embeds/index.js';
import { createErasureRegistry } from './core/erasure/index.js';
import { AppError } from './core/errors/app-error.js';
import { createShutdown } from './core/errors/handler.js';
import { createEventRegistry, runReady } from './core/events/index.js';
import { loadModules, migrationSources } from './core/loader/index.js';
import { loadManifests, resolveIntents } from './core/loader/manifests.js';
import { createLogger } from './core/logging/index.js';
import { createPurgeRegistry } from './core/purge/index.js';
import { createMinecraftBridge } from './minecraft/index.js';
import { fromRoot } from './utils/paths.js';

/**
 * Assemblage du bot.
 *
 * L'ordre est contraint de bout en bout : les manifestes précèdent la
 * configuration, dont ils complètent le schéma ; la configuration précède le
 * logger, dont le niveau vient d'elle ; la base précède les modules, dont les
 * migrations s'appliquent dessus ; la connexion précède la vérification des
 * références, que seule l'API peut trancher.
 *
 * Les fermetures s'inscrivent dans l'ordre d'ouverture et se déroulent à
 * l'envers : les journaux, inscrits d'office en premier, partent en dernier et
 * peuvent relater les fermetures précédentes.
 */

/**
 * Intents du noyau : le fonctionnement de base ne demande rien d'autre
 * (socle §12). Les modules déclarent les leurs dans leur manifeste, et l'union
 * se fait à l'étape 0.
 */
const CORE_INTENTS = ['Guilds'];

/** Migrations du noyau, propriétaire `core`. */
const CORE_MIGRATIONS = { owner: CORE_OWNER, directory: fromRoot('migrations') };

export async function bootstrap() {
  // ---------------------------------------------------------------------
  // 0. Manifestes des modules — avant les secrets, donc avant tout.
  //    Ce que les modules déclarent ici décide de ce que la configuration
  //    doit valider et des intents avec lesquels le client se construit :
  //    deux choses nécessaires avant que le reste ne puisse exister.
  // ---------------------------------------------------------------------
  let manifests;
  let intents;

  try {
    manifests = await loadManifests();
    intents = resolveIntents([...CORE_INTENTS, ...manifests.intents]);
  } catch (cause) {
    if (!(cause instanceof AppError)) throw cause;

    // Aucun logger à ce stade, comme pour les secrets : stderr puis sortie.
    process.stderr.write(`${cause.message}\n`);
    return process.exit(1);
  }

  // ---------------------------------------------------------------------
  // 1. Secrets et configuration — sans journalisation possible : le logger
  //    se règle depuis ce qui est lu ici.
  // ---------------------------------------------------------------------
  const { env, errors: envErrors } = loadEnv();

  if (envErrors.length > 0) {
    process.stderr.write(`${formatErrors(envErrors, 'Secrets manquants')}\n`);
    return process.exit(1);
  }

  // La validation porte sur l'intégralité du fichier, sections de modules
  // comprises : une section qu'aucun schéma ne couvre laisserait passer une
  // faute de frappe ou un identifiant sans guillemets.
  const config = new Configuration({
    configSchema: buildConfigSchema(manifests.fragments),
    knownSections: [...CORE_SECTION_NAMES, ...Object.keys(manifests.fragments)],
  });

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
  const events = createEventRegistry({ logger: logger.forModule('events'), capabilities });
  const components = createComponentRegistry({
    config,
    logger: logger.forModule('components'),
    embeds,
    capabilities,
  });

  // Les intents sont lus une seule fois, ici : ajouter un module qui en réclame
  // un nouveau reste un redémarrage, /reload n'y peut rien.
  logger.info('intents Discord', { intents: intents.names, privileged: intents.privileged });

  const client = new Client({ intents: intents.bits });

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
    components.register(module.name, module.components);
    events.register(module.name, module.events);
  }

  for (const module of modules) {
    if (module.init !== null) await module.init({ ...context, module: module.name });
  }

  // Après les init — un écouteur peut dépendre de ce qu'elles montent — mais
  // avant la connexion : posés depuis clientReady, les écouteurs manqueraient
  // tout ce qui arrive entre la connexion et l'exécution de la séquence.
  events.attach(client, context);

  // Rapport au démarrage, jamais à la première utilisation : une commande sans
  // configuration est refusée à tous, et le découvrir en production est
  // plusieurs jours trop tard.
  const unconfigured = commands.unconfigured();

  if (unconfigured.length > 0) {
    logger.error('commandes sans entrée dans config.yml, elles seront refusées', {
      commands: unconfigured,
    });
  }

  // Même contrôle pour les composants : une clé de permission qui ne résout pas
  // rend le bouton muet pour tous, et on le découvrirait quand un membre clique
  // sur « Se vérifier » sans jamais entrer sur le serveur.
  const unroutable = components.unconfigured();

  if (unroutable.length > 0) {
    logger.error('composants dont la clé de permission ne résout pas, ils seront refusés', {
      components: unroutable,
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
        listeners: events.size,
        capabilities_disabled: refs.disabled,
        modules_disabled: refs.disabledModules,
      });

      // Après verifyDiscordRefs(), jamais avant : un module dont la référence
      // critique manque vient d'être désactivé, et publierait sinon dans un
      // salon qui n'existe plus. Chaque ready est enveloppé, aucun n'empêche la
      // purge de démarrer.
      await runReady({ modules, context, capabilities, logger: logger.forModule('events') });

      purge.start();
    } catch (cause) {
      logger.error('initialisation après connexion en échec', { error: cause });
    }
  });

  client.on('interactionCreate', (interaction) => {
    // Ni handle() ne lève jamais : une interaction sans réponse laisse
    // « L'application ne répond pas » à l'écran.
    void routeInteraction(interaction, { commands, components, context });
  });

  client.on('error', (error) => logger.error('erreur du client Discord', { error }));

  await login(client, env.DISCORD_TOKEN, intents.privileged);

  return { config, logger, database, client, shutdown, uninstall, context };
}

/**
 * Connexion, et diagnostic de ce que Discord ne dit pas.
 *
 * Discord ferme la passerelle sans nommer l'intent fautif quand un intent
 * privilégié n'est pas coché dans le portail développeur. discord.js relaie une
 * Error nue, sans code ni classe propre — s'appuyer sur sa forme se casserait à
 * la première montée de version. On n'y touche donc pas : l'erreur d'origine
 * part en `cause`, et le message porte la liste des intents privilégiés
 * demandés, seule chose que le bot sache et que l'opérateur ait besoin de lire.
 *
 * Écrit aussi sur stderr : c'est le troisième blocage de démarrage de la même
 * famille, après les secrets manquants et la configuration invalide, et les
 * deux autres y passent déjà. En production le journal n'écrit qu'en fichier
 * JSON — l'opérateur qui vient de cocher un intent regarde `pm2 logs`, pas
 * `logs/cubex-AAAA-MM-JJ.log`.
 */
async function login(client, token, privileged) {
  try {
    await client.login(token);
  } catch (cause) {
    const message =
      privileged.length > 0
        ? `connexion à Discord refusée (${cause.message}) — intents privilégiés demandés : ` +
          `${privileged.join(', ')} ; vérifier qu'ils sont activés dans le portail développeur`
        : `connexion à Discord refusée (${cause.message})`;

    process.stderr.write(`${message}\n`);

    throw new AppError(message, {
      code: 'discord_login_failed',
      context: { privileged },
      cause,
      expected: false,
    });
  }
}

// Démarre uniquement quand ce fichier est le point d'entrée : un import depuis
// un test ne doit pas connecter le bot.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await bootstrap();
}
