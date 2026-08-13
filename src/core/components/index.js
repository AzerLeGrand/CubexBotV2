import { isAllowed, roleIdsOf } from '../commands/permissions.js';
import { PUBLIC } from '../config/schema/primitives.js';
import { EPHEMERAL } from '../discord/flags.js';
import { AppError, isExpected } from '../errors/app-error.js';

/**
 * Composants persistants : boutons, menus déroulants, soumissions de modale.
 *
 * Les trois portent un `customId`, et c'est tout ce dont le routage a besoin :
 * même décodage, même registre, même aiguillage.
 *
 * **Aucun collecteur temporaire.** Un collecteur attaché à une instance de
 * message cesse de répondre dès que le processus redémarre, et le composant
 * devient muet sans la moindre erreur visible. Le routage se fait donc sur un
 * identifiant FIXE, inscrit dans le message au moment où il est publié et
 * retrouvé à chaque clic, redémarrage compris.
 *
 *     module:action:arg1:arg2
 *
 * Le nom du module en tête est un espace de nommage : deux modules déclarent
 * `confirm` sans se marcher dessus, et le routage se fait sur le premier
 * segment. Aucun module ne construit cet identifiant à la main — `encodeCustomId`
 * est le seul chemin, et le seul endroit où les refus sont posés.
 *
 * Ce que ce routeur NE fait PAS, délibérément :
 *
 * - **Il n'accuse jamais réception à la place du module.** `showModal()` doit
 *   être la PREMIÈRE réponse à une interaction : un `deferReply()` posé ici
 *   rendrait toute modale impossible, partout. C'est au module de savoir s'il
 *   ouvre une modale ou s'il défère avant un traitement long.
 * - **Il ne vérifie aucune propriété de message.** Discord garantit déjà qu'un
 *   composant porté par un message éphémère n'est cliquable que par son
 *   destinataire. Un composant public qui doit se restreindre inscrit
 *   l'identifiant du membre dans son `customId` — non falsifiable, puisqu'il
 *   provient d'un message que le bot a lui-même posté. Ne pas ajouter cette
 *   couche plus tard.
 */

/** Séparateur réservé : aucun segment ne peut le contenir. */
const SEPARATOR = ':';

/**
 * Longueur maximale d'un `customId`.
 *
 * Relevée dans `@discordjs/builders` — `customIdValidator` impose
 * `lengthLessThanOrEqual(100)` — plutôt que dans la documentation : la
 * contrainte est ainsi vérifiable depuis le dépôt à chaque montée de version.
 *
 * En dur au titre de la seconde exception de `CLAUDE.md`, comme `EMBED_LIMITS` :
 * la configurer permettrait de la relever, et Discord rejetterait le composant.
 */
const CUSTOM_ID_MAX = 100;

/** Forme d'une action. Même discipline que le nom d'une commande. */
const ACTION = /^[a-z0-9_-]+$/;

/** Composant qui ne route plus : vieux message, ou identifiant d'un autre bot. */
const EXPIRED = 'component_expired';

// ---------------------------------------------------------------------------
// Identifiant
// ---------------------------------------------------------------------------

/**
 * Construit l'identifiant persistant d'un composant.
 *
 * **Refus, jamais troncature.** Un identifiant coupé à 100 caractères ne route
 * nulle part — ou pire, route vers autre chose si la coupure tombe au milieu
 * d'un segment. Mieux vaut un composant qu'on ne peut pas publier qu'un
 * composant publié qui trahit.
 *
 * Les arguments sont des CHAÎNES, sans conversion de complaisance. Accepter un
 * nombre reviendrait à accepter qu'un identifiant Discord passe par là : au-delà
 * de 16 chiffres, il est déjà tronqué avant d'arriver ici. Un module qui pagine
 * écrit `String(page)` et assume sa conversion.
 *
 * @param {string} module nom du module, tel qu'il l'exporte
 * @param {string} action action déclarée au registre
 * @param {...string} args arguments transmis à `execute`
 * @returns {string}
 */
export function encodeCustomId(module, action, ...args) {
  const segments = [module, action, ...args];

  for (const [index, segment] of segments.entries()) {
    // Les arguments sont numérotés comme `args[]`, tel que `execute` le reçoit :
    // c'est l'indice que le développeur a sous les yeux de l'autre côté.
    const where = index === 0 ? 'module' : index === 1 ? 'action' : `argument ${index - 2}`;

    if (typeof segment !== 'string' || segment.length === 0) {
      // Un segment vide est presque toujours une variable non définie qu'on
      // aurait convertie sans s'en apercevoir.
      throw fault(`${where} : chaîne non vide attendue, reçu ${describe(segment)}`, { module, action });
    }

    if (segment.includes(SEPARATOR)) {
      throw fault(
        `${where} : ${SEPARATOR} est le séparateur réservé, il ne peut pas figurer dans un segment`,
        { module, action },
      );
    }
  }

  const customId = segments.join(SEPARATOR);

  if (customId.length > CUSTOM_ID_MAX) {
    throw fault(
      `${customId.length} caractères pour un plafond de ${CUSTOM_ID_MAX} — un identifiant ` +
        'tronqué ne route nulle part : transporter une clé, jamais un contenu',
      { module, action, length: customId.length },
    );
  }

  return customId;
}

/**
 * Décode un identifiant reçu de Discord.
 *
 * Tolérant là où `encodeCustomId` est strict, et pour une raison : la chaîne
 * vient d'un message qui peut avoir été publié il y a des mois, par une version
 * antérieure du bot. Elle est décrite, pas jugée — seule l'absence de module ou
 * d'action empêche de router.
 *
 * @returns {{ module: string, action: string, args: string[] } | null}
 */
export function decodeCustomId(customId) {
  if (typeof customId !== 'string' || customId.length === 0) return null;

  const [module, action, ...args] = customId.split(SEPARATOR);

  if (!module || !action) return null;

  return { module, action, args };
}

// ---------------------------------------------------------------------------
// Registre
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.logger
 * @param {object} options.embeds       moteur de rendu, pour les réponses de refus
 * @param {object} options.capabilities registre des capacités (socle §5.5)
 */
export function createComponentRegistry({ config, logger, embeds, capabilities }) {
  /** @type {Map<string, object>} clé `module:action` */
  const entries = new Map();

  /**
   * Inscrit les composants d'un module.
   *
   * Une déclaration porte SOIT `permission: 'public'`, SOIT `permission_key`,
   * un chemin vers `config.yml` — jamais une liste de rôles écrite dans le
   * code, qui échapperait au rechargement à chaud comme à la relecture.
   */
  function register(owner, list = []) {
    for (const declaration of list) {
      const fault = (message) => {
        throw new AppError(`composant « ${declaration?.action} » de ${owner} : ${message}`, {
          code: 'component_invalid',
          context: { owner, action: declaration?.action },
          expected: false,
        });
      };

      if (typeof declaration?.action !== 'string' || !ACTION.test(declaration.action)) {
        fault('« action » attendue : minuscules, chiffres, tiret ou tiret bas');
      }

      if (typeof declaration.execute !== 'function') fault('« execute » doit être une fonction');

      const open = declaration.permission !== undefined;
      const keyed = declaration.permission_key !== undefined;

      // Aucun défaut, dans un sens comme dans l'autre : ouvrir par défaut
      // reproduirait la liste vide qui ouvrirait /ban à tous, fermer par défaut
      // rendrait muet un bouton destiné aux membres non vérifiés, qui n'ont
      // aucun rôle. L'auteur tranche, ou le bot ne démarre pas.
      if (open && keyed) {
        fault('« permission » et « permission_key » à la fois — l\'une ou l\'autre, jamais les deux');
      }

      if (!open && !keyed) {
        fault(
          'ni « permission » ni « permission_key » — il n\'y a pas de défaut : ouvrir par ' +
            'défaut ouvrirait à tous, fermer par défaut rendrait le composant muet',
        );
      }

      if (open && declaration.permission !== PUBLIC) {
        fault(`« permission » n'admet que le littéral "${PUBLIC}"`);
      }

      if (keyed && typeof declaration.permission_key !== 'string') {
        fault('« permission_key » attendue : un chemin pointé vers config.yml');
      }

      const key = `${owner}${SEPARATOR}${declaration.action}`;

      if (entries.has(key)) fault('déjà déclaré par ce module');

      entries.set(key, {
        owner,
        action: declaration.action,
        permissionKey: keyed ? declaration.permission_key : null,
        execute: declaration.execute,
      });
    }
  }

  /**
   * Composants dont la clé de permission ne résout pas.
   *
   * Même contrôle que `commands.unconfigured()`, et pour la même raison : sans
   * configuration, `isAllowed()` refuse à tous. Le découvrir à la première
   * utilisation, c'est le découvrir quand un membre clique sur « Se vérifier »
   * et n'entre jamais sur le serveur.
   */
  function unconfigured() {
    return [...entries.values()]
      .filter(
        (entry) =>
          entry.permissionKey !== null && config.get(entry.permissionKey, undefined) === undefined,
      )
      .map((entry) => `${entry.owner}${SEPARATOR}${entry.action}`);
  }

  /**
   * Route une interaction portant un `customId`.
   *
   * Ne lève jamais, comme `commands.handle()` : une interaction sans réponse
   * laisse « L'application ne répond pas » à l'écran, et le membre en conclut
   * que le bot est cassé. Chaque sortie répond, toujours en éphémère.
   */
  async function handle(interaction, context = {}) {
    const decoded = decodeCustomId(interaction.customId);
    const entry =
      decoded === null
        ? undefined
        : entries.get(`${decoded.module}${SEPARATOR}${decoded.action}`);

    if (entry === undefined) {
      // Message resté dans un salon après un déploiement qui a retiré le
      // composant, ou identifiant d'un autre bot. Indistinguables de l'extérieur
      // et sans conséquence : les deux se répondent de la même façon.
      logger.warn('composant sans destinataire', { custom_id: interaction.customId });
      await respond(interaction, EXPIRED);
      return;
    }

    if (!capabilities.isModuleEnabled(entry.owner)) {
      logger.info('composant d\'un module désactivé', {
        module: entry.owner,
        action: entry.action,
        reason: capabilities.moduleReason(entry.owner),
      });

      await respond(interaction, 'feature_unavailable');
      return;
    }

    const allowedRoles =
      entry.permissionKey === null ? PUBLIC : config.get(entry.permissionKey, undefined);

    if (!isAllowed(allowedRoles, roleIdsOf(interaction.member))) {
      logger.info('composant refusé', {
        module: entry.owner,
        action: entry.action,
        user: interaction.user?.id,
        configured: allowedRoles !== undefined,
      });

      await respond(interaction, 'command_denied');
      return;
    }

    try {
      // L'interaction en premier, les arguments décodés en dernier : c'est la
      // convention des commandes. L'inversion des écouteurs d'événements ne
      // tenait qu'à leur variadicité — un composant a une arité fixe, rien ne
      // justifierait une TROISIÈME convention. Ne pas « harmoniser ».
      await entry.execute(interaction, { ...context, module: entry.owner }, decoded.args);
    } catch (cause) {
      const error = cause instanceof AppError ? cause : null;

      logger.error('composant en échec', {
        module: entry.owner,
        action: entry.action,
        user: interaction.user?.id,
        expected: isExpected(cause),
        error: cause,
      });

      await respond(interaction, error?.template ?? 'command_failed', error?.variables ?? {});
    }
  }

  /** Répond au seul demandeur. Ne lève jamais : voir `commands.deny()`. */
  async function respond(interaction, template, variables = {}) {
    try {
      const payload = { embeds: [embeds.render(template, variables)], flags: EPHEMERAL };

      // Le module a pu déférer ou répondre avant d'échouer : insister sur
      // `reply()` produirait une seconde erreur par-dessus la première.
      if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
      else await interaction.reply(payload);
    } catch (cause) {
      // L'interaction a expiré, ou le gabarit manque. Rien de plus à tenter.
      logger.error('réponse impossible à un composant', {
        custom_id: interaction.customId,
        error: cause,
      });
    }
  }

  return {
    register,
    unconfigured,
    handle,

    get size() {
      return entries.size;
    },

    list: () => [...entries.values()].map(({ owner, action }) => ({ owner, action })),
  };
}

// ---------------------------------------------------------------------------
// Aiguillage
// ---------------------------------------------------------------------------

/**
 * Aiguille une interaction vers le registre qui la traite.
 *
 * Vit dans le noyau plutôt que dans `src/index.js` pour être testable : la
 * non-régression du routage des commandes slash se vérifie ici, sans client.
 *
 * @returns {Promise<void>|null} `null` quand aucun registre ne traite ce type
 */
export function routeInteraction(interaction, { commands, components, context = {} }) {
  if (interaction.isChatInputCommand()) return commands.handle(interaction, context);

  // Boutons, menus de tout type et soumissions de modale portent tous un
  // customId. `isMessageComponent()` couvre les deux premières familles en un
  // seul test — et couvrira un type de composant que la version installée de
  // discord.js ne modélise pas encore, puisque le routage se fait sur le
  // customId et non sur le type.
  if (interaction.isMessageComponent() || interaction.isModalSubmit()) {
    return components.handle(interaction, context);
  }

  // L'autocomplétion n'a pas de customId et se répond par une liste de choix,
  // jamais par un embed : elle relèvera de la commande qui la déclare. Aucune
  // des phases 1 à 6 n'en prévoit.
  return null;
}

const fault = (message, context) =>
  new AppError(`identifiant de composant refusé — ${message}`, {
    code: 'custom_id_invalid',
    context,
    expected: false,
  });

const describe = (value) =>
  typeof value === 'string' ? 'une chaîne vide' : `un ${typeof value}`;
