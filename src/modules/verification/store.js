/**
 * Épreuves en cours, en mémoire.
 *
 * Une entrée par membre : le secret à comparer, l'image déjà rendue, et
 * l'instant où l'ensemble cesse d'être valable. **Aucune écriture en base** —
 * un redémarrage invalide les codes en cours, ce qui est acceptable : le membre
 * en génère un nouveau.
 *
 * Conserver l'image rendue est ce qui rend inutile tout garde-fou anti-spam sur
 * le bouton : recliquer ne recalcule rien. Le coût mesuré est de 17 Ko par
 * entrée, soit environ 3,5 Mo pour deux cents membres simultanés.
 *
 * **CETTE TABLE EST LOCALE AU PROCESSUS.** Une seconde instance du bot aurait
 * ses propres codes, et un membre servi par l'une échouerait auprès de l'autre.
 * Sans conséquence tant qu'une seule tourne — et c'est précisément la raison
 * pour laquelle le VPS doit être coupé avant un démarrage local.
 */

export function createChallengeStore({ config, logger, shutdown = null, now = () => Date.now() }) {
  /** @type {Map<string, { secret: string, attachment: Buffer, expiresAt: number }>} */
  const entries = new Map();

  let timer = null;

  /** Range une épreuve et rend l'entrée, horodatage d'expiration compris. */
  function put(userId, { secret, attachment }) {
    const ttl = config.get('verification.challenge.ttl_seconds');
    const entry = { secret, attachment, expiresAt: now() + ttl * 1000 };

    entries.set(userId, entry);

    return entry;
  }

  /**
   * Épreuve en cours d'un membre, ou `null`.
   *
   * Une entrée échue est retirée au passage plutôt que rendue : le balayage
   * périodique borne la mémoire, il n'est pas ce qui fait respecter la durée de
   * validité.
   */
  function get(userId) {
    const entry = entries.get(userId);

    if (entry === undefined) return null;

    if (entry.expiresAt <= now()) {
      entries.delete(userId);
      return null;
    }

    return entry;
  }

  const drop = (userId) => entries.delete(userId);

  /** Retire les entrées échues. Sans lui, la table ne ferait que croître. */
  function sweep() {
    const limit = now();
    let removed = 0;

    for (const [userId, entry] of entries) {
      if (entry.expiresAt <= limit) {
        entries.delete(userId);
        removed += 1;
      }
    }

    if (removed > 0) logger.debug('épreuves expirées retirées', { removed, held: entries.size });

    return removed;
  }

  /**
   * Arme le passage suivant, puis se réarme.
   *
   * `setTimeout` qui se réarme plutôt qu'un `setInterval`, comme la purge du
   * noyau : l'intervalle est relu à chaque tour, donc un rechargement à chaud
   * qui le change est pris en compte au passage suivant plutôt qu'au prochain
   * redémarrage.
   */
  function schedule() {
    const seconds = config.get('verification.challenge.sweep_interval_seconds');

    timer = setTimeout(() => {
      try {
        sweep();
      } catch (error) {
        // Un balayage en échec ne doit pas interrompre la planification : la
        // table cesserait de se vider, en silence.
        logger.error('balayage des épreuves interrompu', { error });
      }

      schedule();
    }, seconds * 1000);

    // Ce minuteur ne doit pas maintenir le processus en vie à lui seul.
    timer.unref?.();
  }

  const registry = {
    put,
    get,
    drop,
    sweep,

    get size() {
      return entries.size;
    },

    start() {
      if (timer === null) schedule();
      return registry;
    },

    stop() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };

  // **Le balayage DOIT s'inscrire à la séquence d'arrêt.** Un minuteur non
  // annulé retient le processus et fait échouer la fermeture propre — `unref()`
  // couvre le cas normal, pas celui d'un minuteur armé pendant l'arrêt. Plafond
  // court : `stop()` est un `clearTimeout` synchrone, et la somme des plafonds
  // doit rester sous le `kill_timeout` de pm2.
  shutdown?.register('verification-challenges', () => registry.stop(), { timeoutMs: 1_000 });

  return registry;
}
