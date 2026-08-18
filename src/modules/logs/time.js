/**
 * Horodatage des événements journalisés.
 *
 * Une seule forme est écrite en base, et elle n'est pas négociable : **ISO 8601
 * en UTC, avec le `T` et les millisecondes** — `2026-08-18T14:32:07.512Z`.
 *
 * Trois raisons, qui ferment chacune un piège distinct.
 *
 * **Jamais `datetime('now')` en SQL.** Il produit un espace au lieu du `T`.
 * L'espace (0x20) précède le `T` (0x54) en binaire, et la purge comparant des
 * chaînes, toutes les lignes du jour passeraient pour antérieures au seuil. Une
 * erreur d'une journée, tous les jours, invisible à l'œil. Le registre de purge
 * inspecte la première valeur non nulle et refuse la table si la forme dévie.
 *
 * **Jamais `bot.timezone` ici.** Le fuseau sert à l'AFFICHAGE, au lot 4. Une
 * date stockée avec un décalage local devient incomparable dès que le fuseau
 * change — et deux lignes écrites de part et d'autre d'un passage à l'heure
 * d'hiver ne s'ordonneraient plus entre elles.
 *
 * **Aucune primitive dépendante de l'environnement.** Ni `toLocaleString`, ni
 * `localeCompare`, ni `getHours` : `toISOString()` rend exactement la même
 * chaîne sur le poste Windows et sur le VPS Debian, quelle que soit l'ICU
 * chargée.
 */

const BAD_DATE =
  'horodatage attendu : une instance de Date valide — un Invalid Date écrirait ' +
  'la chaîne « Invalid Date » en base, que la purge refuserait ensuite sans dire pourquoi';

/**
 * Convertit une `Date` en horodatage stockable.
 *
 * Rejette une entrée invalide plutôt que de laisser passer un `Invalid Date` :
 * `new Date(undefined).toISOString()` lève déjà, mais avec un `RangeError` nu
 * qui ne dit ni quel champ ni quel appelant. Une valeur non-`Date` — une chaîne
 * déjà formatée, un timestamp en millisecondes — est refusée au même titre :
 * l'accepter ferait exister deux chemins d'écriture, donc deux formes possibles
 * en base.
 *
 * @param {Date} date
 * @returns {string} `2026-08-18T14:32:07.512Z`
 * @throws {TypeError} si `date` n'est pas une Date valide
 */
export function toIsoUtc(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    // Le type reçu suffit au diagnostic, et la valeur n'est jamais citée : ces
    // journaux partiront vers Discord en phase 6.
    throw new TypeError(`${BAD_DATE} (reçu : ${typeof date})`);
  }

  return date.toISOString();
}
