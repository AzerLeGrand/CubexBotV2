import { createWriteStream, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { MESSAGE } from 'triple-beam';
import Transport from 'winston-transport';

/**
 * Transport winston écrivant un fichier par jour et supprimant les plus anciens.
 *
 * Écrit ici plutôt que repris de `winston-daily-rotate-file` : ce paquet n'a
 * reçu aucun commit depuis mars 2024 et épingle `file-stream-rotator@^0.6.1`,
 * figé depuis janvier 2022. La dette se serait réveillée à la première montée
 * de Node, et il aurait fallu écrire le remplacement dans l'urgence.
 *
 * Trois responsabilités, pas une de plus : un descripteur ouvert, une
 * vérification de date à l'écriture, un balayage du dossier une fois par jour.
 */

/** `en-CA` rend une date au format AAAA-MM-JJ, directement comparable. */
const DAY_FORMAT = { year: 'numeric', month: '2-digit', day: '2-digit' };

const MS_PER_DAY = 86_400_000;

export class RotatingFileTransport extends Transport {
  #directory;
  #prefix;
  #retentionDays;
  #formatter;
  #pattern;

  #stream = null;
  #day = null;

  /**
   * @param {object} options
   * @param {string} options.directory     dossier des journaux
   * @param {string} options.prefix        préfixe des noms de fichier
   * @param {number} options.retentionDays durée de conservation, en jours
   * @param {string} options.timezone      fuseau déterminant le changement de jour
   */
  constructor({ directory, prefix, retentionDays, timezone, ...options }) {
    super(options);

    this.#directory = directory;
    this.#prefix = prefix;
    this.#retentionDays = retentionDays;
    this.#formatter = new Intl.DateTimeFormat('en-CA', { ...DAY_FORMAT, timeZone: timezone });
    this.#pattern = new RegExp(`^${prefix}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);

    mkdirSync(directory, { recursive: true });
    this.sweep();
  }

  log(info, callback) {
    setImmediate(() => this.emit('logged', info));

    try {
      // info[MESSAGE] porte la ligne telle que le pipeline de formatage l'a
      // produite : c'est là que vivra le masquage de la phase 6. Reformater
      // ici la court-circuiterait.
      this.#current().write(`${info[MESSAGE]}\n`);
    } catch (cause) {
      // Jamais de journalisation ici : l'échec d'écriture du journal se
      // signale à winston, qui a son propre canal. L'inverse boucle.
      this.emit('error', cause);
    }

    callback();
  }

  /**
   * Supprime les fichiers dépassant la durée de conservation.
   *
   * Une erreur sur un fichier n'interrompt pas les autres — un journal
   * verrouillé par un éditeur ne doit pas empêcher la purge des trente autres.
   *
   * @returns {{ deleted: number, failed: number }}
   */
  sweep() {
    const limit = this.#dayOf(new Date(Date.now() - this.#retentionDays * MS_PER_DAY));

    let deleted = 0;
    let failed = 0;

    let entries;
    try {
      entries = readdirSync(this.#directory);
    } catch {
      return { deleted, failed };
    }

    for (const entry of entries) {
      const match = this.#pattern.exec(entry);

      // Comparaison lexicographique : sur AAAA-MM-JJ elle est chronologique.
      if (match === null || match[1] >= limit) continue;

      try {
        unlinkSync(join(this.#directory, entry));
        deleted += 1;
      } catch {
        failed += 1;
      }
    }

    return { deleted, failed };
  }

  close() {
    this.#stream?.end();
    this.#stream = null;
    this.#day = null;
  }

  /** Descripteur du jour, réouvert et suivi d'un balayage au changement de date. */
  #current() {
    const day = this.#dayOf(new Date());

    if (day !== this.#day) {
      this.#stream?.end();

      this.#day = day;
      this.#stream = createWriteStream(join(this.#directory, `${this.#prefix}-${day}.log`), {
        flags: 'a',
      });
      this.#stream.on('error', (cause) => this.emit('error', cause));

      // Une seule fois par jour, au moment où le fichier tourne : pas de
      // minuterie à armer, à désarmer, ni à oublier à l'extinction.
      if (this.#retentionDays > 0) this.sweep();
    }

    return this.#stream;
  }

  #dayOf(date) {
    return this.#formatter.format(date);
  }
}
