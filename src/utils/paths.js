import { join, posix, resolve, win32 } from 'node:path';

/** `C:` ou `C:dossier` — relatif au répertoire courant du lecteur, non portable. */
const DRIVE_LETTER = /^[a-zA-Z]:/;

/**
 * Ce chemin est-il absolu, selon l'une **ou l'autre** convention ?
 *
 * `path.isAbsolute()` dépend de la plateforme d'exécution : `C:\data\bot.db`
 * est absolu sous Windows et ne l'est pas sous Linux, où seul `/` ouvre un
 * chemin absolu. Une valeur venue d'un fichier versionné doit être jugée de la
 * même façon partout — un chemin en `C:\` commité depuis un poste Windows doit
 * être refusé aussi sur le VPS, pas accepté puis résolu en un chemin absurde.
 */
export const isAbsolutePath = (value) =>
  typeof value === 'string' &&
  (win32.isAbsolute(value) || posix.isAbsolute(value) || DRIVE_LETTER.test(value));

// Les chemins sont résolus depuis l'emplacement du module, jamais depuis le
// répertoire de travail : sous pm2 celui-ci dépend de la manière dont le
// processus a été démarré et n'est pas garanti être la racine du projet.
//
// Deux niveaux : src/utils/paths.js → src/utils → src → racine.
export const projectRoot = resolve(import.meta.dirname, '..', '..');

export const configDir = join(projectRoot, 'config');
export const envFile = join(projectRoot, '.env');

// Les emplacements de la base et des journaux viennent de config.yml et non
// d'ici : seule leur résolution en chemin absolu passe par projectRoot.
export const fromRoot = (...segments) => join(projectRoot, ...segments);
