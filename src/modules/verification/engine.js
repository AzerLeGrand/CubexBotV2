import { AppError } from '../../core/errors/app-error.js';

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
   *
   * `onAccepted` est exécuté **avant** que la réussite ne soit écrite, et son
   * échec annule tout. C'est ce qui rend l'ordre impossible à inverser : écrire
   * la réussite d'abord laisserait un membre sans rôle et sans ligne d'état,
   * donc invité à recommencer un captcha qu'il vient de résoudre, avec un
   * compteur reparti de zéro.
   *
   * Le moteur ne sait pas ce que fait cette promesse — il attend qu'elle
   * aboutisse, rien de plus. C'est ce qui le garde ignorant de Discord.
   */
  async function submit({ userId, hasRole, input, onAccepted }) {
    if (hasRole) return { outcome: OUTCOMES.already_verified };
    if (repository.isBlocked(userId)) return blocked(false);

    const held = store.get(userId);

    // Expiré, ou disparu avec le redémarrage qui a vidé la mémoire. Les deux
    // sont la même chose pour le membre, qui a une image sous les yeux et un
    // code qui n'existe plus.
    if (held === null) return { outcome: OUTCOMES.expired };

    if (challenge.accepts(held.secret, input)) {
      if (typeof onAccepted !== 'function') {
        // Exigé sur ce seul chemin : un appelant qui l'oublie doit s'en rendre
        // compte bruyamment, pas obtenir une réussite écrite sans que l'action
        // qui la justifie ait eu lieu.
        throw new AppError('« onAccepted » est requis pour valider une épreuve', {
          code: 'verification_on_accepted_missing',
          context: { user: userId },
          expected: false,
        });
      }

      // Aucune tentative n'est consommée sur ce chemin — on est après un
      // `accepts()` vrai. Propriété facile à casser lors d'une refonte : un
      // échec d'`onAccepted` ne doit rien coûter au membre non plus.
      await onAccepted();

      // Après `onAccepted` seulement. Si celui-ci lève, on ressort d'ici sans
      // avoir rien touché : le code reste valable jusqu'à son expiration, et le
      // membre qui reclique retombe sur la même image sans qu'on la régénère.
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
