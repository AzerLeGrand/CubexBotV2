/**
 * Module de vérification (phase 1).
 *
 * Contrôle d'accès à l'entrée du serveur : un nouveau membre n'accède au reste
 * du serveur qu'après avoir résolu un captcha.
 *
 * Le module déclare ses tables, ses références Discord, ce qu'il confie aux
 * registres de purge et d'effacement, et monte le moteur du captcha. Les
 * boutons, la modale et la commande de déblocage arrivent aux lots suivants :
 * rien n'est encore visible sur le serveur.
 */

import { createChallenge } from './challenge/index.js';
import { createCommands } from './commands.js';
import { createComponents } from './components.js';
import { createVerificationEngine } from './engine.js';
import { createVerificationRepository } from './repository.js';
import { createChallengeStore } from './store.js';
import { ensureWelcome, storedWelcomeId, useRepository } from './welcome.js';

export const name = 'verification';

/**
 * Migrations du module, numérotées pour lui seul : `verification/001` et
 * `core/001` coexistent sans se gêner, la table de suivi les distingue par leur
 * propriétaire.
 */
export const migrations = './migrations';

/**
 * Rétention (spec section 7).
 *
 * L'historique seul est purgé. `verification_state` ne l'est jamais — un
 * blocage supprimé automatiquement se lèverait tout seul, ce qui viderait le
 * mécanisme de son sens — et `verification_message` non plus, une ligne par
 * salon ne pesant rien.
 */
export const retention = [
  {
    table: 'verification_history',
    date_column: 'created_at',
    retention_key: 'verification.retention.history_days',
  },
];

/**
 * Droit à l'effacement (spec section 8).
 *
 * Trois déclarations pour deux tables, et c'est la première fois du projet que
 * deux stratégies coexistent sur une même table. C'est ce qui justifie que le
 * registre distingue par COLONNE et non par table.
 *
 * `user_id` disparaît : ce sont les données du membre qui demande l'effacement.
 *
 * `actor_id` est ANONYMISÉ, jamais supprimé. Il porte l'identifiant du membre
 * du staff qui a débloqué quelqu'un — donnée personnelle, qui doit donc partir
 * si ce modérateur le demande. Mais `delete` sur cette colonne supprimerait les
 * lignes d'historique D'AUTRES MEMBRES, celles où ce modérateur est intervenu :
 * on effacerait les données de gens qui n'ont rien demandé. `anonymize` est la
 * seule stratégie correcte ici, et elle passe le garde-fou du socle 0.2 puisque
 * `actor_id` ne porte aucune contrainte d'unicité — contrairement à
 * `verification_state.user_id`, qui est clé primaire et que le garde-fou
 * refuserait.
 */
export const erasure = [
  { table: 'verification_state', user_column: 'user_id', strategy: 'delete' },
  { table: 'verification_history', user_column: 'user_id', strategy: 'delete' },
  { table: 'verification_history', user_column: 'actor_id', strategy: 'anonymize' },
];

/**
 * Moteur monté par `init()`, consommé par les composants du lot suivant.
 *
 * État de module plutôt que valeur rendue : le chargeur du noyau ignore ce que
 * `init()` retourne, et un composant déclaré dans `components` ne reçoit que
 * l'interaction et le contexte du noyau — jamais l'assemblage interne du
 * module.
 */
let engine = null;
let repository = null;

/** @returns {object|null} `null` tant qu'`init()` n'a pas tourné. */
export const getEngine = () => engine;

/**
 * Monte le captcha : l'épreuve, la mémoire des codes et le moteur.
 *
 * Appelée avant la connexion. Tout ce qui peut être validé au démarrage l'est —
 * `prepare()` vérifie ici que la police se charge, plutôt que de découvrir un
 * `font_path` erroné au premier clic d'un membre, sur une image de carrés
 * vides.
 */
export function init(ctx) {
  const logger = ctx.logger.forModule(name);
  const challenge = createChallenge({ config: ctx.config, logger });

  challenge.prepare();

  const store = createChallengeStore({
    config: ctx.config,
    logger,
    shutdown: ctx.shutdown,
  }).start();

  repository = createVerificationRepository({ database: ctx.database });

  engine = createVerificationEngine({ config: ctx.config, challenge, store, repository });

  // Le message d'accueil se lit et s'écrit hors du moteur : il ne relève pas
  // de la logique de tentatives.
  useRepository(repository);

  logger.info('captcha monté', {
    challenge: challenge.type,
    ttl_seconds: ctx.config.get('verification.challenge.ttl_seconds'),
    max_attempts: ctx.config.get('verification.max_attempts'),
  });
}

/**
 * Boutons et modale, routés par identifiant persistant.
 *
 * Le moteur leur est passé par une fonction et non par valeur : `components`
 * est évalué à l'import du module, bien avant qu'`init()` ne l'ait monté.
 */
export const components = createComponents({ engine: getEngine });

/**
 * Commande de déblocage, réservée à la modération.
 *
 * Sa liste de rôles vit dans `commands.unblock.allowed_roles`, section du
 * noyau, et non dans celle du module : les permissions de commande sont un
 * mécanisme du socle, identique pour tous les modules.
 */
export const commands = createCommands({ engine: getEngine });

/**
 * Publie le message d'accueil au démarrage.
 *
 * Dans `ready` et non dans un écouteur `clientReady` : celui-ci partirait en
 * parallèle de la séquence du noyau et publierait avant de savoir si la
 * capacité du module est active — un salon supprimé, et le bot publierait dans
 * le vide. Le noyau refuse d'ailleurs cette déclaration.
 *
 * Un module désactivé ne reçoit pas `ready` : rien n'est publié quand le salon
 * ou le rôle est introuvable.
 */
export async function ready(ctx) {
  const result = await ensureWelcome(ctx);

  ctx.logger.forModule(name).info('message de vérification vérifié', result);
}

/**
 * Republication en cours de fonctionnement.
 *
 * Le filtre porte sur l'identifiant du salon et sur celui stocké en base,
 * JAMAIS sur le contenu de l'événement : `messageDelete` arrive aussi pour des
 * messages absents du cache, sous une forme partielle où le contenu manque.
 *
 * Aucune boucle possible : la republication enregistre immédiatement le nouvel
 * identifiant, donc un événement portant l'ancien ne correspond plus à ce que
 * la base contient. C'est ce qui rend inutile un drapeau « c'est moi qui l'ai
 * supprimé ».
 */
export const events = [
  {
    name: 'messageDelete',
    async execute(ctx, message) {
      const channelId = ctx.config.get('verification.channel_id');

      if (message.channelId !== channelId) return;
      if (storedWelcomeId(channelId) !== message.id) return;

      const result = await ensureWelcome(ctx);

      ctx.logger.forModule(name).info('message de vérification republié', result);
    },
  },
];

/**
 * Capacités et références Discord dont elles dépendent (spec §9).
 *
 * Une référence introuvable au démarrage n'arrête pas le bot : elle désactive
 * sa capacité, et le module continue avec ce qui reste. Marquée `critical`,
 * elle désactive le module entier.
 *
 * Les deux alertes partagent le salon et se distinguent par leur rôle. C'est ce
 * découpage qui produit exactement les effets du §9, sans une ligne de code :
 * le salon perdu fait tomber les deux déclarations, un rôle perdu ne fait
 * tomber que la sienne — la vérification des références s'arrête à la première
 * référence manquante d'une déclaration.
 */
export const capabilities = [
  {
    // Sans salon de vérification, il n'y a pas de message d'accueil, donc pas
    // de porte d'entrée : le module n'a plus rien à faire.
    id: 'verification.channel',
    critical: true,
    refs: [{ kind: 'channel', path: 'verification.channel_id' }],
  },
  {
    // Une vérification réussie qui n'aboutit à aucun rôle laisserait le membre
    // devant la même porte : mieux vaut se taire que promettre une entrée.
    id: 'verification.role',
    critical: true,
    refs: [{ kind: 'role', path: 'verification.member_role_id' }],
  },
  {
    id: 'verification.alert.exhausted',
    refs: [
      { kind: 'channel', path: 'verification.alert.channel_id' },
      { kind: 'role', path: 'verification.alert.exhausted_role_id' },
    ],
  },
  {
    id: 'verification.alert.failure',
    refs: [
      { kind: 'channel', path: 'verification.alert.channel_id' },
      { kind: 'role', path: 'verification.alert.failure_role_id' },
    ],
  },
  {
    // La journalisation Discord se tait, la base continue d'enregistrer : un
    // salon supprimé ne doit pas faire perdre l'historique.
    id: 'verification.log',
    refs: [{ kind: 'channel', path: 'verification.log.channel_id' }],
  },
];
