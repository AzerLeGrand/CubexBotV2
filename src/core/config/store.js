import { EventEmitter } from 'node:events';

/**
 * Conteneur de la configuration courante.
 *
 * Le remplacement est atomique : une seule affectation, après validation
 * complète. À aucun instant un lecteur ne voit une configuration à moitié
 * remplacée, et un rechargement refusé ne touche rien.
 */

/** `categories[game]` — nom de clé, puis identité de l'entrée dans une collection. */
const SEGMENT = /^([^[\]]+)(?:\[([^[\]]+)\])?$/;

/**
 * Résout un chemin pointé.
 *
 * Une entrée de collection s'adresse par sa clé `id`, jamais par sa position :
 * `tickets.categories[game].category_id`. Réordonner les catégories dans
 * `config.yml` déplacerait silencieusement un indice d'une entrée à l'autre.
 *
 * @returns {unknown} `undefined` si une étape du chemin manque
 */
export function resolve(root, path) {
  let node = root;

  for (const segment of String(path).split('.')) {
    if (node === null || node === undefined) return undefined;

    const match = SEGMENT.exec(segment);
    if (match === null) return undefined;

    const [, key, id] = match;
    node = node[key];

    if (id !== undefined) {
      if (!Array.isArray(node)) return undefined;
      node = node.find((item) => item !== null && typeof item === 'object' && item.id === id);
    }
  }

  return node;
}

export class ConfigStore extends EventEmitter {
  /** @type {{ config: object, messages: object, embeds: object } | null} */
  #data = null;

  get loaded() {
    return this.#data !== null;
  }

  get config() {
    return this.#data?.config ?? null;
  }

  get messages() {
    return this.#data?.messages ?? null;
  }

  get embeds() {
    return this.#data?.embeds ?? null;
  }

  /**
   * Installe une configuration validée à la place de la précédente et prévient
   * les abonnés.
   *
   * @param {object} data ensemble validé des trois fichiers
   * @param {object} [meta] contexte transmis aux abonnés, dont l'auteur du rechargement
   * @returns {object | null} la configuration remplacée
   */
  replace(data, meta = {}) {
    const previous = this.#data;

    this.#data = data;
    this.emit('reload', { ...meta, previous, current: data });

    return previous;
  }

  /**
   * Lit une valeur de `config.yml` par son chemin.
   *
   * Sans valeur de repli, un chemin inconnu lève : la validation garantit que
   * toute clé déclarée existe, donc un chemin qui ne résout pas est une faute
   * de frappe dans le code appelant. La laisser remonter en `undefined` la
   * ferait ressortir bien plus loin, sous la forme d'un calcul absurde.
   *
   * @param {string} path chemin pointé, `tickets.categories[game].category_id`
   * @param {...unknown} fallback valeur rendue si le chemin ne résout pas
   */
  get(path, ...fallback) {
    if (this.#data === null) {
      if (fallback.length > 0) return fallback[0];
      throw new Error(`configuration non chargée, lecture impossible : ${path}`);
    }

    const value = resolve(this.#data.config, path);

    if (value === undefined) {
      if (fallback.length > 0) return fallback[0];
      throw new Error(`chemin de configuration inconnu : ${path}`);
    }

    return value;
  }
}
