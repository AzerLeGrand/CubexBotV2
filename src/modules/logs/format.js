/**
 * Horodatage d'AFFICHAGE.
 *
 * **À ne pas confondre avec `toIsoUtc()` du lot 2**, qui reste réservé au
 * stockage. Les deux formatent une date et n'ont rien d'autre en commun :
 *
 * | | `toIsoUtc()` | `formatTime()` |
 * |-|-|-|
 * | destination | la base | un lecteur humain |
 * | fuseau | UTC, toujours | `bot.timezone` |
 * | forme | ISO 8601 strict | heure lisible |
 * | comparable | oui, lexicographiquement | jamais |
 *
 * Une valeur d'affichage ne doit JAMAIS repartir en base : la purge compare des
 * chaînes, et un horodatage local casserait l'ordre à chaque changement d'heure.
 *
 * L'horodatage natif des embeds n'est pas concerné : il est posé par le moteur
 * du socle, et Discord l'affiche dans le fuseau de chaque lecteur.
 */

/**
 * Marqueur d'un horodatage illisible.
 *
 * Ni exception — un embed entier serait perdu pour une date — ni chaîne vide,
 * qui laisserait un trou que personne ne remarque. Même nature que l'`…` de
 * `core/embeds/limits.js` : un glyphe de repli, pas un message.
 *
 * Exporté pour que l'appelant le reconnaisse et le journalise.
 */
export const INVALID_TIME = '--:--:--';

/**
 * Formateurs mis en cache, par fuseau.
 *
 * Construire un `Intl.DateTimeFormat` coûte cher, et une purge de cent messages
 * en demanderait cent. Le fuseau ne change qu'au rechargement, la carte reste
 * donc minuscule.
 */
const formatters = new Map();

/**
 * `en-CA` et des composantes NUMÉRIQUES explicites, comme partout dans le
 * projet.
 *
 * Une locale explicite plutôt que celle du système : le poste Windows et le VPS
 * Debian doivent produire la même chaîne. Un format nommé — `timeStyle: 'medium'`
 * — dépendrait des données ICU chargées et pourrait rendre « 16:32:07 » ici et
 * « 4:32:07 PM » là. `hourCycle: 'h23'` ferme le dernier écart : en `h24`,
 * minuit se lit « 24 ».
 */
const PARTS = Object.freeze({
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const formatterFor = (timezone) => {
  if (!formatters.has(timezone)) {
    formatters.set(timezone, new Intl.DateTimeFormat('en-CA', { ...PARTS, timeZone: timezone }));
  }

  return formatters.get(timezone);
};

/**
 * Rend l'heure d'un horodatage stocké, dans le fuseau du serveur.
 *
 * Seule l'heure, sans la date : les événements d'un même lot tiennent dans une
 * fenêtre de quelques secondes, et l'horodatage natif de l'embed porte déjà le
 * jour — dans le fuseau de chaque lecteur, ce qui est mieux pour la date.
 *
 * **Le fuseau est obligatoire.** Aucun repli sur celui du système : il diffère
 * entre le poste de développement et le VPS, et le repli produirait des heures
 * fausses sans rien signaler.
 *
 * @param {string} isoString horodatage tel que `toIsoUtc()` l'a écrit
 * @param {string} timezone  `bot.timezone`, jamais déduit
 * @returns {string} `16:32:07`, ou `INVALID_TIME`
 */
export function formatTime(isoString, timezone) {
  if (typeof timezone !== 'string' || timezone.length === 0) {
    // Défaut de programmation : `bot.timezone` est une clé obligatoire du
    // schéma du noyau, elle ne peut pas manquer à l'exécution.
    throw new TypeError('fuseau horaire obligatoire pour formater un horodatage');
  }

  // Une CHAÎNE, et rien d'autre. `new Date(42)` est une date parfaitement
  // valide — quarante-deux millisecondes après l'époque — et l'accepter ferait
  // afficher une heure de 1970 là où un appelant s'est trompé de champ. La
  // colonne `occurred_at` est en TEXT : ce qui n'en vient pas n'a rien à faire
  // ici.
  if (typeof isoString !== 'string') return INVALID_TIME;

  const at = new Date(isoString);

  // `Invalid Date` plutôt qu'une levée : la ligne est déjà en base, et un embed
  // perdu pour une date illisible serait une punition disproportionnée.
  if (Number.isNaN(at.getTime())) return INVALID_TIME;

  try {
    return formatterFor(timezone).format(at);
  } catch {
    // Fuseau inconnu de l'ICU chargée. La validation du noyau l'a pourtant
    // vérifié au démarrage, mais les données ICU du VPS peuvent différer de
    // celles du poste : mieux vaut un marqueur qu'un embed perdu.
    return INVALID_TIME;
  }
}
