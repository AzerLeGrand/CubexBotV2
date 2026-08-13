/**
 * Registre des capacités (socle §5.5).
 *
 * Une référence Discord introuvable au démarrage ne doit pas arrêter le bot :
 * elle désactive la fonctionnalité qui en dépend, laquelle répond qu'elle est
 * indisponible. Ce registre porte cet état, et lui seul décide de ce qui
 * répond.
 */

export class CapabilityRegistry {
  /** @type {Map<string, { id: string, enabled: boolean, reason: string | null }>} */
  #states = new Map();

  /**
   * Déclare une capacité, activée par défaut.
   *
   * Déclarer avant de vérifier permet de répondre « indisponible » plutôt que
   * « inconnue » sur une capacité dont la vérification n'a pas encore eu lieu.
   */
  declare(id) {
    if (!this.#states.has(id)) this.#states.set(id, { id, enabled: true, reason: null });

    return this;
  }

  /** Désactive une capacité en conservant le motif, qui sera affiché au staff. */
  disable(id, reason) {
    this.declare(id);
    Object.assign(this.#states.get(id), { enabled: false, reason });

    return this;
  }

  enable(id) {
    this.declare(id);
    Object.assign(this.#states.get(id), { enabled: true, reason: null });

    return this;
  }

  /**
   * Une capacité jamais déclarée est considérée active.
   *
   * Le contraire ferait taire toute fonctionnalité dont on aurait oublié la
   * déclaration, alors que rien ne prouve qu'elle soit en défaut.
   */
  isEnabled(id) {
    return this.#states.get(id)?.enabled ?? true;
  }

  reasonFor(id) {
    return this.#states.get(id)?.reason ?? null;
  }

  /** Remet tout à l'état déclaré, avant une nouvelle vérification. */
  reset() {
    for (const state of this.#states.values()) Object.assign(state, { enabled: true, reason: null });

    return this;
  }

  list() {
    return [...this.#states.values()].map((state) => ({ ...state }));
  }

  disabled() {
    return this.list().filter((state) => !state.enabled);
  }
}
