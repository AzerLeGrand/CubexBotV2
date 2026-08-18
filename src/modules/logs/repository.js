/**
 * Accès aux deux tables du module.
 *
 * Tout le SQL du module vit ici, et **rien de ce fichier ne parle à Discord** :
 * l'écriture en base est immédiate et indépendante du groupement d'affichage
 * (spec §5). Un incident au moment de l'envoi vers Discord ne doit jamais faire
 * perdre la donnée.
 *
 * Toutes les valeurs passent en paramètres liés, sans une seule interpolation de
 * chaîne : le contenu d'un message est saisi par un membre, et c'est ce qui
 * transite ici.
 */

export function createLogRepository({ database }) {
  const statements = {
    insertEvent: database.prepare(
      `INSERT INTO log_events (
         event_type, occurred_at, actor_id, actor_confidence,
         target_id, channel_id, source, audit_log_entry_id, data
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    insertContent: database.prepare(
      `INSERT INTO log_message_content (
         event_id, created_at, author_id, content_before, content_after, attachments
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    /**
     * **Les colonnes sont énumérées et toutes viennent de `log_events`.** Ni
     * `SELECT *`, ni jointure : voir `findByTarget()`.
     */
    byTarget: database.prepare(
      `SELECT id, event_type, occurred_at, actor_id, actor_confidence,
              target_id, channel_id, source, audit_log_entry_id, data
         FROM log_events
        WHERE target_id = ?
        ORDER BY occurred_at DESC, id DESC
        LIMIT ? OFFSET ?`,
    ),
    countByTarget: database.prepare('SELECT COUNT(*) AS n FROM log_events WHERE target_id = ?'),
    lastEventAt: database.prepare('SELECT MAX(occurred_at) AS at FROM log_events'),
    hasAuditEntry: database.prepare(
      'SELECT 1 AS found FROM log_events WHERE audit_log_entry_id = ? LIMIT 1',
    ),
  };

  /**
   * Enregistre un événement, et son contenu de message s'il y en a un.
   *
   * **Les deux écritures sont dans la MÊME transaction.** Un arrêt entre les
   * deux laisserait une ligne de métadonnées annonçant un contenu qui n'existe
   * pas : l'affichage promettrait un message supprimé et n'aurait rien à
   * montrer, sans qu'aucune erreur ne le signale.
   *
   * `created_at` du contenu RECOPIE `occurredAt` plutôt que d'être fourni à
   * part : les deux tables portent le même instant, sous deux rétentions
   * différentes. Laisser l'appelant les dissocier ouvrirait la porte à un
   * contenu purgé avant ou après son propre événement.
   *
   * @param {object} event
   * @param {string} event.eventType         valeur de `LOG_EVENTS`
   * @param {string} event.occurredAt        ISO 8601 avec T, via `toISOString()`
   * @param {string|null} [event.actorId]    auteur de l'action, si identifié
   * @param {string} event.actorConfidence   valeur d'`ACTOR_CONFIDENCE`
   * @param {string|null} [event.targetId]   membre concerné
   * @param {string|null} [event.channelId]  salon concerné
   * @param {string} event.source            valeur d'`EVENT_SOURCE`
   * @param {string|null} [event.auditLogEntryId]
   * @param {object} [event.data]            détail propre au type, sérialisé en JSON
   * @param {object|null} [event.content]    `{ authorId, before, after, attachments }`
   * @returns {number} identifiant de la ligne insérée dans `log_events`
   */
  const insertEvent = database.transaction((event) => {
    const info = statements.insertEvent.run(
      event.eventType,
      event.occurredAt,
      event.actorId ?? null,
      event.actorConfidence,
      event.targetId ?? null,
      event.channelId ?? null,
      event.source,
      event.auditLogEntryId ?? null,
      JSON.stringify(event.data ?? {}),
    );

    // `lastInsertRowid` est un BigInt dès que la base grossit : converti ici, à
    // la source, plutôt que de laisser un BigInt filer dans le reste du module
    // où il se comparerait mal à un nombre ordinaire.
    const id = Number(info.lastInsertRowid);

    if (event.content != null) {
      const { authorId = null, before = null, after = null, attachments = null } = event.content;

      statements.insertContent.run(
        id,
        event.occurredAt,
        authorId,
        before,
        after,
        // `null` reste `null` : une colonne vide se distingue d'un « aucune
        // pièce jointe » sérialisé, et évite d'écrire "[]" sur chaque message.
        attachments == null ? null : JSON.stringify(attachments),
      );
    }

    return id;
  });

  /**
   * Événements dont un membre est la cible, du plus récent au plus ancien.
   *
   * **NE REND JAMAIS DE CONTENU DE MESSAGE.** Ni jointure, ni `SELECT *` : c'est
   * une décision de la spec §7, pas une optimisation. Le contenu reste
   * consultable dans le salon de logs, noyé dans le flux chronologique ; une
   * recherche ciblée qui le restituerait permettrait de reconstituer d'un coup
   * l'activité complète d'une personne.
   *
   * `limit` et `offset` sont OBLIGATOIRES et sans défaut : la taille de page est
   * un réglage de `config.yml`, et un défaut écrit ici serait précisément la
   * valeur codée en dur que le projet refuse.
   *
   * @param {string} userId
   * @param {{ limit: number, offset: number }} page
   */
  const findByTarget = (userId, { limit, offset }) => statements.byTarget.all(userId, limit, offset);

  return {
    insertEvent,
    findByTarget,

    /** Total des événements visant un membre, pour la pagination du lot 6. */
    countByTarget: (userId) => statements.countByTarget.get(userId).n,

    /**
     * Horodatage du dernier événement enregistré, ou `null` sur base vide.
     *
     * Point de départ du rattrapage du lot 7 : le journal d'audit est relu
     * depuis cette date. `null` vaut « rien à rattraper », et non « tout
     * rattraper » — un premier démarrage ne doit pas déverser l'historique.
     */
    lastEventAt: () => statements.lastEventAt.get().at ?? null,

    /**
     * Cette entrée du journal d'audit est-elle déjà enregistrée ?
     *
     * Dédoublonnage du rattrapage : un événement reçu en direct juste avant
     * l'arrêt figure aussi dans le journal d'audit, et serait sinon réécrit puis
     * republié au redémarrage.
     */
    hasAuditEntry: (auditLogEntryId) =>
      statements.hasAuditEntry.get(auditLogEntryId) !== undefined,
  };
}
