import { OUTCOMES } from './constants.js';

/**
 * Moteur de vérification : décide, ne dialogue pas.
 *
 * **Il ne connaît ni Discord, ni `messages.yml`, ni `embeds.yml`.** Il rend un
 * résultat, et l'appelant en tire un message. C'est ce qui rend l'ensemble
 * testable sans le moindre objet discord.js — et ce qui permettra de changer la
 * formulation d'un refus sans toucher à la logique de tentatives.
 *
 * `hasRole` arrive en argument pour la même raison : savoir si un membre porte
 * déjà le rôle est la seule information Discord dont le moteur ait besoin, et
 * la lui faire chercher lui-même l'obligerait à connaître la bibliothèque.
 */

export function createVerificationEngine({ config, challenge, store, repository }) {
  const maxAttempts = () => config.get('verification.max_attempts');

  /**
   * Un membre déjà bloqué qui reclique.
   *
   * `justBlocked` distingue ce cas de celui du membre qui vient d'épuiser ses
   * tentatives. Sans cette distinction, l'alerte staff partirait à chaque clic
   * d'un membre bloqué, alors que la spec la veut à l'épuisement UNIQUEMENT —
   * et une alerte qui se répète finit coupée par ceux qui la portent.
   */
  const blocked = (justBlocked) => ({ outcome: OUTCOMES.blocked, justBlocked });

  /**
   * Le membre demande une épreuve.
   *
   * Recliquer pendant la validité rend LE MÊME code et LA MÊME image : aucun
   * nouveau tirage, aucun rendu recalculé. C'est ce qui rend inutile tout
   * garde-fou anti-spam sur le bouton, et la durée de validité plafonne à elle
   * seule le rythme de génération.
   */
  function begin({ userId, hasRole }) {
    if (hasRole) return { outcome: OUTCOMES.already_verified };
    if (repository.isBlocked(userId)) return blocked(false);

    const held = store.get(userId);

    if (held !== null) {
      return {
        outcome: OUTCOMES.issued,
        attachment: held.attachment,
        expiresAt: held.expiresAt,
        reused: true,
      };
    }

    const { secret, attachment } = challenge.issue();
    const entry = store.put(userId, { secret, attachment });

    return {
      outcome: OUTCOMES.issued,
      attachment: entry.attachment,
      expiresAt: entry.expiresAt,
      reused: false,
    };
  }

  /**
   * Le membre soumet un code.
   *
   * Ce qui consomme une tentative se limite au code faux. Ni l'expiration, ni
   * l'absence d'épreuve en mémoire après un redémarrage, ni le rôle déjà porté
   * n'en coûtent une : dans ces trois cas le membre n'a pas fauté, et lui
   * décompter une tentative le rapprocherait d'un blocage qu'il n'a pas mérité.
   */
  function submit({ userId, hasRole, input }) {
    if (hasRole) return { outcome: OUTCOMES.already_verified };
    if (repository.isBlocked(userId)) return blocked(false);

    const held = store.get(userId);

    // Expiré, ou disparu avec le redémarrage qui a vidé la mémoire. Les deux
    // sont la même chose pour le membre, qui a une image sous les yeux et un
    // code qui n'existe plus.
    if (held === null) return { outcome: OUTCOMES.expired };

    if (challenge.accepts(held.secret, input)) {
      store.drop(userId);
      repository.registerSuccess(userId);

      return { outcome: OUTCOMES.success };
    }

    const limit = maxAttempts();
    const { attempts, blocked: nowBlocked } = repository.registerFailure(userId, limit);

    if (nowBlocked) {
      // L'épreuve ne sert plus à rien : la garder en mémoire retiendrait 17 Ko
      // par membre bloqué jusqu'au balayage.
      store.drop(userId);

      return blocked(true);
    }

    return { outcome: OUTCOMES.wrong, remaining: Math.max(0, limit - attempts) };
  }

  return { begin, submit };
}
