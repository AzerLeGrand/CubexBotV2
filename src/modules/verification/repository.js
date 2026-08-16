import { HISTORY_EVENTS } from './constants.js';

/**
 * Accès aux trois tables du module.
 *
 * Tout le SQL du module vit ici : le moteur décide, ce fichier écrit. Les
 * horodatages passent tous par `toISOString()`, en ISO 8601 strict avec `T` —
 * jamais `datetime('now')`, dont l'espace ferait passer toutes les lignes du
 * jour pour antérieures au seuil de purge.
 */

export function createVerificationRepository({ database, now = () => new Date().toISOString() }) {
  const statements = {
    find: database.prepare('SELECT * FROM verification_state WHERE user_id = ?'),
    upsert: database.prepare(
      `INSERT INTO verification_state (user_id, attempts, blocked_at, updated_at)
       VALUES (?, ?, NULL, ?)
       ON CONFLICT (user_id) DO UPDATE SET attempts = excluded.attempts, updated_at = excluded.updated_at`,
    ),
    block: database.prepare(
      'UPDATE verification_state SET blocked_at = ?, updated_at = ? WHERE user_id = ?',
    ),
    clear: database.prepare('DELETE FROM verification_state WHERE user_id = ?'),
    record: database.prepare(
      'INSERT INTO verification_history (user_id, event, actor_id, created_at) VALUES (?, ?, ?, ?)',
    ),
    findMessage: database.prepare('SELECT * FROM verification_message WHERE channel_id = ?'),
    saveMessage: database.prepare(
      `INSERT INTO verification_message (channel_id, message_id, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT (channel_id) DO UPDATE SET message_id = excluded.message_id, updated_at = excluded.updated_at`,
    ),
  };

  /** Ligne d'état d'un membre, ou `null` — l'absence vaut compteur à zéro. */
  const find = (userId) => statements.find.get(userId) ?? null;

  /**
   * Le membre est-il bloqué ?
   *
   * Lu depuis `blocked_at`, JAMAIS déduit de `attempts >= max_attempts` : le
   * seuil est configurable, et le déduire ferait bloquer rétroactivement des
   * membres qui n'ont rien fait — ou débloquer en silence des comptes que le
   * staff a laissés bloqués.
   */
  const isBlocked = (userId) => find(userId)?.blocked_at != null;

  /**
   * Enregistre un échec, et le blocage s'il en découle.
   *
   * **Les deux écritures sont dans la MÊME transaction, avec leurs lignes
   * d'historique.** Un arrêt entre l'incrément et la pose du blocage laisserait
   * un membre à cinq tentatives sur cinq et jamais bloqué, donc en tentatives
   * illimitées : exactement ce que le mécanisme empêche.
   *
   * @returns {{ attempts: number, blocked: boolean }}
   */
  const registerFailure = database.transaction((userId, maxAttempts) => {
    const at = now();
    const attempts = (find(userId)?.attempts ?? 0) + 1;

    statements.upsert.run(userId, attempts, at);
    statements.record.run(userId, HISTORY_EVENTS.failure, null, at);

    const blocked = attempts >= maxAttempts;

    if (blocked) {
      statements.block.run(at, at, userId);
      statements.record.run(userId, HISTORY_EVENTS.block, null, at);
    }

    return { attempts, blocked };
  });

  /**
   * Enregistre une vérification réussie.
   *
   * La ligne d'état est SUPPRIMÉE et non remise à zéro : un membre vérifié n'a
   * plus rien à faire dans cette table, et un membre bloqué ne peut pas réussir
   * — supprimer ne perd donc aucun blocage. L'absence de ligne se lit comme un
   * compteur à zéro.
   *
   * En transaction, comme l'échec : une suppression sans sa ligne d'historique
   * laisserait une vérification dont il ne resterait aucune trace.
   */
  const registerSuccess = database.transaction((userId) => {
    const at = now();

    statements.clear.run(userId);
    statements.record.run(userId, HISTORY_EVENTS.success, null, at);
  });

  /**
   * Lève un blocage à la demande du staff.
   *
   * **SUPPRIME la ligne**, exactement comme la réussite. Cette table ne contient
   * que les vérifications en cours et les blocages actifs : une ligne à zéro
   * sans blocage n'est ni l'un ni l'autre, et s'accumulerait à chaque
   * déblocage. L'absence de ligne se lit comme un compteur à zéro.
   *
   * L'historique n'est écrit **que si quelque chose a changé**. Une commande
   * sans effet n'est pas une action, et l'inscrire polluerait l'historique qui
   * sert justement à retrouver ce qui s'est passé.
   *
   * `wasBlocked` distingue le déblocage de la simple remise à zéro d'un
   * compteur : le modérateur doit savoir laquelle des deux il vient de faire.
   *
   * @returns {{ changed: boolean, wasBlocked: boolean }}
   */
  const registerUnblock = database.transaction((userId, actorId) => {
    const state = find(userId);

    if (state === null) return { changed: false, wasBlocked: false };

    const wasBlocked = state.blocked_at != null;

    statements.clear.run(userId);
    statements.record.run(userId, HISTORY_EVENTS.unblock, actorId, now());

    return { changed: true, wasBlocked };
  });

  return {
    find,
    isBlocked,
    registerFailure,
    registerSuccess,
    registerUnblock,

    /** Historique brut d'un membre, du plus ancien au plus récent. */
    history: (userId) =>
      database
        .prepare('SELECT * FROM verification_history WHERE user_id = ? ORDER BY id')
        .all(userId),

    /** Message permanent du salon de vérification (lot suivant). */
    message: {
      find: (channelId) => statements.findMessage.get(channelId) ?? null,
      save: (channelId, messageId) => statements.saveMessage.run(channelId, messageId, now()),
    },
  };
}
