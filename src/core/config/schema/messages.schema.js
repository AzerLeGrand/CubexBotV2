import { z } from 'zod';

/**
 * `messages.yml` — tous les textes destinés aux utilisateurs.
 *
 * Validation volontairement souple : aucune liste de clés attendues. Chaque
 * module range ses textes où il le souhaite, et la seule vérification qui
 * compte — que chaque `*_key` de `config.yml` et chaque `*_key` d'un gabarit
 * pointe vers un texte existant — appartient à la validation croisée, qui a les
 * trois fichiers sous la main. L'inverse, un texte présent mais inutilisé, n'a
 * rien d'une erreur.
 *
 * Souple sur la structure ne veut pas dire permissif sur les feuilles : seules
 * des chaînes sont acceptées. C'est ce qui empêche un réglage technique de
 * s'égarer ici, où il échapperait à la validation de `config.yml`.
 */

const BAD_NODE =
  'texte attendu : une chaîne, une liste de lignes, ou un sous-ensemble de clés — ' +
  'messages.yml ne contient aucun réglage technique';

const MessageNode = z.lazy(() =>
  z.union([z.string(), z.array(z.string()), z.record(z.string(), MessageNode)], {
    error: BAD_NODE,
  }),
);

export const MessagesSchema = z.record(z.string(), MessageNode);
