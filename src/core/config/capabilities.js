/**
 * Registre des capacités (socle §5.5).
 *
 * Une référence Discord introuvable au démarrage ne doit pas arrêter le bot :
 * elle désactive la fonctionnalité qui en dépend, laquelle répond qu'elle est
 * indisponible. Ce registre porte cet état, et lui seul décide de ce qui
 * répond.
 */

export class CapabilityRegistry {
  /** @type {Map<string, { id, module, enabled, reason }>} */
  #states = new Map();

  /** Modules désactivés en bloc, et le motif. */
  #modules = new Map();

  /**
   * Déclare une capacité, activée par défaut.
   *
   * Déclarer avant de vérifier permet de répondre « indisponible » plutôt que
   * « inconnue » sur une capacité dont la vérification n'a pas encore eu lieu.
   *
   * `module` rattache la capacité à son propriétaire : c'est ce qui permet à
   * une référence critique de désactiver l'ensemble.
   */
  declare(id, { module = null } = {}) {
    if (!this.#states.has(id)) {
      this.#states.set(id, { id, module, enabled: true, reason: null });
    } else if (module !== null) {
      this.#states.get(id).module = module;
    }

    return this;
  }

  /**
   * Désactive un module entier et toutes ses capacités.
   *
   * Appelé quand une référence marquée `critical` est introuvable. Le bot ne
   * s'arrête pas pour autant (socle §5.5) : c'est le module qui se tait.
   */
  disableModule(module, reason) {
    this.#modules.set(module, reason);

    for (const state of this.#states.values()) {
      if (state.module === module) Object.assign(state, { enabled: false, reason });
    }

    return this;
  }

  isModuleEnabled(module) {
    return !this.#modules.has(module);
  }

  moduleReason(module) {
    return this.#modules.get(module) ?? null;
  }

  disabledModules() {
    return [...this.#modules].map(([module, reason]) => ({ module, reason }));
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

  /**
   * Une capacité est active si elle l'est elle-même et si son module l'est.
   *
   * Un module désactivé après coup fait taire des capacités déclarées avant
   * lui : la double vérification évite de dépendre de l'ordre des appels.
   */
  isActive(id) {
    const state = this.#states.get(id);

    if (state === undefined) return true;

    return state.enabled && (state.module === null || this.isModuleEnabled(state.module));
  }

  /** Remet tout à l'état déclaré, avant une nouvelle vérification. */
  reset() {
    this.#modules.clear();
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
