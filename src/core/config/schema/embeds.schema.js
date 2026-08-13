import { z } from 'zod';

import { color, hexColor, messageKey } from './primitives.js';

/**
 * `embeds.yml` — gabarits d'affichage. Aucun texte ni couleur n'est écrit dans
 * le code (socle §9).
 */

/**
 * Les quatre clés de la palette sont une interface publique : le module
 * d'embeds de la phase 5 les expose telles quelles au staff, qui les saisit
 * dans une modale. Elles sont donc obligatoires et nommées, là où le reste du
 * fichier est ouvert.
 */
export const PALETTE_KEYS = Object.freeze(['brand', 'success', 'error', 'info']);

const PaletteSchema = z.strictObject({
  brand: hexColor(),
  success: hexColor(),
  error: hexColor(),
  info: hexColor(),
});

/**
 * Pied de page commun à tous les embeds. Le texte est un nom de marque, non un
 * message : il reste ici plutôt que dans messages.yml, avec le reste du
 * gabarit d'affichage.
 */
const FooterSchema = z.strictObject({
  text: z.string({ error: 'texte de pied de page attendu' }).min(1, 'texte de pied de page vide'),
  timestamp: z.boolean({ error: 'bascule attendue : true ou false' }),
});

/**
 * Un gabarit ne porte que des renvois vers messages.yml et une couleur. Le
 * titre est facultatif — un embed peut n'être qu'une description.
 */
const TemplateSchema = z.strictObject({
  color: color(),
  title_key: messageKey().optional(),
  description_key: messageKey(),
});

export const EmbedsSchema = z.strictObject({
  colors: PaletteSchema,
  footer: FooterSchema,
  templates: z.record(z.string(), TemplateSchema),
});
