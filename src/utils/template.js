/**
 * Moteur de substitution des variables de gabarit (socle §9).
 *
 * Syntaxe : accolade simple, nom en anglais — `{username}`, `{count}`.
 *
 * Brique autonome et partagée : elle sert aux gabarits d'`embeds.yml`, aux
 * textes de `messages.yml` et à certaines valeurs de `config.yml`, dont le
 * gabarit de nommage des salons de ticket. Ce n'est donc pas un service du
 * moteur d'embeds, et elle vit hors de `src/core/`.
 *
 * Elle n'importe pas la journalisation : une variable non fournie est remontée
 * à l'appelant, qui décide quoi en faire.
 */

/**
 * Un nom de variable suit la convention des clés de configuration : minuscules,
 * chiffres et tirets bas, commençant par une lettre.
 *
 * Ce motif strict tient lieu d'échappement. Une accolade qui n'encadre pas un
 * nom conforme est laissée telle quelle et n'est pas signalée : un extrait de
 * JSON ou de CSS dans un message reste intact. Il n'existe pas d'autre moyen
 * d'écrire une accolade littérale, et c'est assumé — aucun texte du bot n'a
 * besoin d'afficher `{username}` sans le substituer.
 */
const VARIABLE = /\{([a-z][a-z0-9_]*)\}/g;

/**
 * Noms des variables présentes dans un gabarit, dans l'ordre d'apparition et
 * sans doublon.
 *
 * @param {string | string[]} template
 * @returns {string[]}
 */
export function variablesOf(template) {
  const text = join(template);
  const names = [];

  for (const [, name] of text.matchAll(VARIABLE)) {
    if (!names.includes(name)) names.push(name);
  }

  return names;
}

/**
 * Rend un gabarit.
 *
 * Une variable non fournie reste visible sous sa forme `{nom}` dans le texte
 * rendu, et son nom est remonté dans `missing`. C'est délibéré : le socle §9
 * interdit l'affichage vide silencieux, qui laisserait passer une phrase
 * amputée sans que personne ne s'en aperçoive. Un marqueur resté en place se
 * voit, et le journal de l'appelant dit lequel.
 *
 * Une variable fournie mais absente du gabarit est ignorée sans bruit : les
 * appelants passent souvent un contexte plus large que nécessaire.
 *
 * @param {string | string[]} template chaîne, ou liste de lignes jointes par des sauts de ligne
 * @param {Record<string, unknown>} [variables]
 * @returns {{ text: string, missing: string[] }}
 */
export function render(template, variables = {}) {
  const missing = [];

  const text = join(template).replace(VARIABLE, (marker, name) => {
    const value = variables[name];

    if (value === undefined || value === null) {
      if (!missing.includes(name)) missing.push(name);
      return marker;
    }

    return String(value);
  });

  return { text, missing };
}

/** Les textes de messages.yml peuvent être une liste de lignes. */
const join = (template) => (Array.isArray(template) ? template.join('\n') : String(template));
