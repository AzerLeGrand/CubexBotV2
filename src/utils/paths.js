import { join, resolve } from 'node:path';

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
