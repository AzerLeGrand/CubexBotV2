import { AuditLogEvent } from 'discord.js';

import { createAuditSource } from './audit-source.js';
import { createMemberListeners } from './members.js';
import { createModerationListeners } from './moderation.js';
import { createRoleSource } from './role-source.js';
import { createSender } from './sender.js';

/**
 * Frontière avec discord.js.
 *
 * **La bibliothèque n'est importée que sous ce dossier.** Tout le reste du
 * module — normalisation, corrélation, exclusions, rendu, aiguillage — n'en
 * connaît rien et s'éprouve donc sans réseau, sans jeton et sans serveur. C'est
 * ce qui permet aux lots 1 à 4 d'être vérifiés en mémoire, et ce qui rend
 * remplaçable la seule couche qui ne le soit pas. Un test d'isolation le
 * vérifie.
 *
 * Ce fichier assemble : il ne traduit rien lui-même. Chaque adaptateur a le sien.
 */

/**
 * Accès Discord attendus par `attach()`.
 *
 * Construits APRÈS la connexion, dans `ready(ctx)` : ni le serveur, ni
 * l'identité du bot n'existent avant. Le module tourne en attendant, en mode
 * dégradé explicite.
 *
 * `AuditLogEvent` sert deux fois et vient du MÊME import : une fois pour
 * traduire nos noms d'action en entiers d'API, une fois pour que `attach()`
 * vérifie que `AUDIT_ACTIONS` n'a pas divergé de la bibliothèque. Deux imports
 * distincts autoriseraient un jour deux versions, et la vérification porterait
 * alors sur autre chose que ce qu'on interroge.
 *
 * @param {object} options
 * @param {object} options.client  client connecté
 * @param {string} options.guildId `bot.guild_id`
 * @param {object} options.logger
 */
export async function createDiscordAccess({ client, guildId, logger }) {
  const guild = await client.guilds.fetch(guildId);

  return {
    fetchEntries: createAuditSource({ guild, auditLogEvent: AuditLogEvent, logger }),
    resolveRoles: createRoleSource({ guild, logger }),
    // `client.user.id` et JAMAIS une clé de configuration : la protection contre
    // la boucle est une garantie structurelle, elle ne doit pas dépendre d'une
    // valeur qu'un vidage de liste suffirait à lever (spec §4).
    botUserId: client.user.id,
    send: createSender({ client, logger }),
    auditActions: AuditLogEvent,
  };
}

/**
 * Écouteurs de passerelle, familles membres et modération.
 *
 * Construits à l'import du module, bien avant la connexion : le noyau les pose
 * sur le client avant `login()`, pour ne rien manquer de ce qui arrive pendant
 * sa séquence de démarrage. Le recorder leur est donc passé par une FONCTION,
 * qui ne sera appelée qu'au premier événement reçu.
 *
 * Un fichier par famille, découpé selon le SIGNAL de passerelle et non selon le
 * salon de destination : une expulsion arrive en `guildMemberRemove` et vit donc
 * chez les membres, quel que soit le salon vers lequel `config.yml` l'envoie.
 *
 * Les familles messages, vocal et serveur appartiennent au lot suivant.
 */
export const createDiscordListeners = ({ recorder }) => [
  ...createMemberListeners({ recorder }),
  ...createModerationListeners({ recorder }),
];
