/**
 * Adaptateur vers le journal d'audit de discord.js.
 *
 * Traduit `guild.fetchAuditLogs()` vers le contrat `fetchEntries` que le cache
 * du lot 3 attend. **Aucune logique métier ici** : ni fenêtre, ni compteur, ni
 * décision d'attribution — tout cela vit dans `audit.js` et `correlation.js`,
 * qui n'ont jamais vu discord.js et doivent le rester.
 *
 * L'énumération est INJECTÉE plutôt qu'importée. Non par scrupule d'isolation —
 * ce dossier a le droit d'importer la bibliothèque — mais parce que le câblage
 * doit fournir exactement la même énumération à `attach()`, qui la vérifie
 * contre `AUDIT_ACTIONS`. Deux imports séparés autoriseraient un jour deux
 * versions, et la vérification porterait alors sur autre chose que ce qu'on
 * interroge.
 */

/**
 * Compteur d'une entrée.
 *
 * Discord ne crée pas une entrée par acte : un même modérateur supprimant
 * plusieurs messages du même auteur dans le même salon INCRÉMENTE une entrée
 * existante. Les actions sans compteur valent 1 — c'est la forme uniforme que
 * `AuditEntry` impose, et elle évite un `?? 1` disséminé chez l'appelant.
 */
const countOf = (entry) =>
  typeof entry.extra?.count === 'number' && entry.extra.count > 0 ? entry.extra.count : 1;

/**
 * Salon porté par l'entrée, quand elle en porte un.
 *
 * `extra` change de forme d'une action à l'autre — un salon pour
 * `MessageDelete`, un rôle pour `ChannelOverwriteCreate`, rien du tout pour la
 * plupart. La chaîne optionnelle traverse les trois cas sans distinguer : ce qui
 * n'est pas un salon rend `null`, et le corrélateur n'exige l'égalité de salon
 * que lorsque l'événement en a un.
 */
const channelOf = (entry) => entry.extra?.channel?.id ?? null;

/**
 * Entrée discord.js → entrée normalisée du lot 3.
 *
 * `actionName` vient de la REQUÊTE et non de `entry.action`. Les deux valent la
 * même chose — on interroge une action à la fois — mais `entry.action` est un
 * ENTIER, et le retraduire en nom demanderait la correspondance inverse de
 * l'énumération. Reprendre le nom demandé donne la même valeur sans dépendre de
 * la façon dont TypeScript compile ses énumérations.
 *
 * `reason` est un champ À PART ENTIÈRE et non un membre d'`extra` : la
 * corrélation le lit et le fait suivre jusqu'à `data`. Ce qui est lu par un
 * consommateur mérite un nom dans le contrat, plutôt qu'une place dans un sac
 * dont la forme est « ce que discord.js y a mis ».
 *
 * `extra` reste ce sac, ni persisté ni lu aujourd'hui : il transporte le détail
 * des changements, que le rattrapage du lot 7 aura besoin de lire.
 */
const normalize = (entry, actionName) => ({
  id: entry.id,
  actionName,
  executorId: entry.executorId ?? null,
  targetId: entry.targetId ?? null,
  channelId: channelOf(entry),
  count: countOf(entry),
  createdAt: entry.createdAt,
  // Texte libre saisi par un modérateur, rendu tel quel : ni coupé ni nettoyé
  // ici. Le bornage appartient à la corrélation, qui a la configuration ; un
  // adaptateur qui couperait aussi ferait deux endroits qui tronquent.
  reason: entry.reason ?? null,
  extra: { changes: entry.changes ?? [] },
});

/**
 * @param {object} options
 * @param {object} options.guild          serveur, obtenu après la connexion
 * @param {Record<string, number>} options.auditLogEvent `AuditLogEvent` de discord.js
 * @param {object} options.logger
 * @returns {(query: { actionName: string, limit: number }) => Promise<object[]>}
 */
export function createAuditSource({ guild, auditLogEvent, logger }) {
  return async function fetchEntries({ actionName, limit }) {
    const type = auditLogEvent?.[actionName];

    if (typeof type !== 'number') {
      // Inatteignable en principe : `attach()` vérifie l'énumération entière au
      // démarrage et refuse de brancher un nom inconnu. Y arriver signifierait
      // que quelqu'un a construit cette source sans passer par le câblage. La
      // levée est rattrapée par le cache, qui journalise et conclut `unknown` —
      // jamais une perte d'événement.
      throw new TypeError(
        `action « ${actionName} » absente de AuditLogEvent — la source d'audit a été ` +
          "construite sans la vérification d'attach()",
      );
    }

    const logs = await guild.fetchAuditLogs({ type, limit });

    // `entries` est une Collection : on en sort un tableau ordinaire, seule
    // forme que le cache connaisse. Rien de discord.js ne doit franchir cette
    // frontière — une Collection amènerait ses méthodes, et le premier appelant
    // qui s'en servirait rendrait `audit.js` dépendant de la bibliothèque.
    const entries = [...logs.entries.values()];

    logger.debug("entrées du journal d'audit lues", { action: actionName, entries: entries.length });

    return entries.map((entry) => normalize(entry, actionName));
  };
}
