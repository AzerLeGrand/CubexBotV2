/**
 * Module de vérification (phase 1).
 *
 * Contrôle d'accès à l'entrée du serveur : un nouveau membre n'accède au reste
 * du serveur qu'après avoir résolu un captcha.
 *
 * Ce lot ne déclare que l'existence du module et ses références Discord. Les
 * tables, le captcha, les boutons et la commande de déblocage arrivent aux lots
 * suivants. Aucun `init` : le chargeur du noyau n'en attend pas d'un module qui
 * n'a rien à monter, et en écrire un vide pour la forme n'apprendrait rien.
 */

export const name = 'verification';

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
