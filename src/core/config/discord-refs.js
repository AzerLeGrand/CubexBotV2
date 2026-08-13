import { resolve } from './store.js';

/**
 * Vérification des références Discord après connexion (socle §5.5).
 *
 * Un identifiant peut être syntaxiquement valide et ne désigner plus rien : un
 * salon supprimé, un rôle renommé puis recréé. La validation de configuration
 * ne peut pas le savoir, seule l'API le peut.
 *
 * Le bot ne s'arrête pas pour autant. Une référence introuvable désactive sa
 * capacité et produit un avertissement ; la fonctionnalité répondra qu'elle est
 * indisponible.
 */

/**
 * Déclaration d'une capacité et des références dont elle dépend.
 *
 * @typedef {object} CapabilityDeclaration
 * @property {string} id              identifiant de la capacité
 * @property {string} [module]        module propriétaire, ajouté par le chargeur
 * @property {boolean} [critical]     l'absence désactive le module entier
 * @property {{ kind: 'role'|'channel'|'category', path: string }[]} refs
 *   `path` est un chemin pointé de `config.yml`. Une entrée de collection s'y
 *   adresse par sa clé `id` — `tickets.categories[game].category_id` — jamais
 *   par sa position : réordonner le fichier déplacerait silencieusement une
 *   capacité d'une entrée à l'autre.
 */

/**
 * Résout les références déclarées auprès de Discord et met à jour le registre.
 *
 * Rejoué à chaque rechargement à chaud : les identifiants ont pu changer, et
 * une capacité désactivée doit pouvoir revenir sans redémarrage.
 *
 * @param {object} options
 * @param {object} options.guild        serveur discord.js
 * @param {object} options.config       configuration chargée
 * @param {CapabilityDeclaration[]} options.declarations
 * @param {object} options.capabilities registre à mettre à jour
 * @param {object} options.logger
 * @returns {Promise<{ checked: number, disabled: string[], missingPaths: string[] }>}
 */
export async function verifyDiscordRefs({
  guild,
  config,
  declarations,
  capabilities,
  logger,
}) {
  // Une capacité revenue doit se réactiver : sans remise à zéro, un
  // rechargement à chaud ne pourrait que dégrader l'état, jamais le rétablir.
  capabilities.reset();

  const disabled = [];
  const disabledModules = [];
  const missingPaths = [];
  let checked = 0;

  for (const declaration of declarations) {
    capabilities.declare(declaration.id, { module: declaration.module ?? null });

    for (const ref of declaration.refs ?? []) {
      const value = resolve(config, ref.path);

      if (value === undefined) {
        // Le chemin déclaré ne résout pas : le manifeste et la configuration
        // ont divergé, probablement après un renommage de clé.
        missingPaths.push(ref.path);
        capabilities.disable(declaration.id, `chemin de configuration inconnu : ${ref.path}`);

        logger.error('référence déclarée sur un chemin inexistant', {
          capability: declaration.id,
          path: ref.path,
        });

        break;
      }

      checked += 1;

      const found = await resolveRef(guild, ref.kind, value);

      if (found === null) {
        const reason = `${label(ref.kind)} introuvable (${ref.path})`;
        const critical = declaration.critical === true && declaration.module != null;

        capabilities.disable(declaration.id, reason);
        disabled.push(declaration.id);

        // `critical` désactive le module entier : le bot ne s'arrête pas, mais
        // le module se tait plutôt que de fonctionner à moitié. Un champ lu
        // sans effet laisserait croire à une garantie qui n'existe pas.
        if (critical) {
          capabilities.disableModule(declaration.module, reason);
          if (!disabledModules.includes(declaration.module)) {
            disabledModules.push(declaration.module);
          }
        }

        logger.warn('référence Discord introuvable, fonctionnalité désactivée', {
          capability: declaration.id,
          module: declaration.module ?? null,
          kind: ref.kind,
          path: ref.path,
          critical,
          scope: critical ? 'module' : 'capacité',
        });

        if (declaration.critical === true && declaration.module == null) {
          // Une capacité du noyau n'appartient à aucun module : il n'y a rien à
          // désactiver en bloc, et le taire ferait croire au contraire.
          logger.error('capacité critique sans module : seule la capacité est désactivée', {
            capability: declaration.id,
          });
        }

        // Une seule référence manquante suffit à désactiver la capacité :
        // inutile de vérifier les suivantes de la même déclaration.
        break;
      }
    }
  }

  if (disabled.length === 0 && missingPaths.length === 0) {
    // Références valides : aucun message, comme l'exige le §5.5.
    logger.debug('références Discord vérifiées', { checked });
  }

  return { checked, disabled, disabledModules, missingPaths };
}

/**
 * Résout une référence auprès du serveur.
 *
 * `fetch` plutôt que le cache : au démarrage, le cache d'un salon jamais vu est
 * vide, et s'y fier signalerait comme introuvables des références parfaitement
 * valides.
 *
 * @returns {Promise<object | null>} `null` si la référence n'existe pas
 */
async function resolveRef(guild, kind, id) {
  try {
    if (kind === 'role') return (await guild.roles.fetch(id)) ?? null;

    const channel = (await guild.channels.fetch(id)) ?? null;

    if (channel === null) return null;

    // Une catégorie est un salon de type 4 : accepter n'importe quel salon là
    // où une catégorie est attendue laisserait créer des tickets dans un salon
    // textuel, ce qui échouerait bien plus tard.
    if (kind === 'category' && channel.type !== CATEGORY_CHANNEL_TYPE) return null;

    return channel;
  } catch {
    // discord.js lève sur un identifiant inconnu ou malformé plutôt que de
    // rendre null. Les deux cas sont la même chose pour nous.
    return null;
  }
}

/** `ChannelType.GuildCategory` de discord.js, sans en dépendre pour un entier. */
const CATEGORY_CHANNEL_TYPE = 4;

const LABELS = { role: 'rôle', channel: 'salon', category: 'catégorie' };

const label = (kind) => LABELS[kind] ?? kind;
