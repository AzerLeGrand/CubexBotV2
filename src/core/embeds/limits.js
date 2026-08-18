/**
 * Limites de la plateforme Discord.
 *
 * En dur au titre de la seconde exception de `CLAUDE.md` : les configurer
 * permettrait de les relever, et l'API rejetterait alors le message entier.
 * Configurer une limite imposée par un tiers reviendrait à permettre de la
 * contourner — sans effet sur le tiers, avec effet sur nous.
 *
 * À vérifier sur la documentation officielle à chaque montée majeure de
 * discord.js : elles sont stables mais pas gravées.
 */
export const EMBED_LIMITS = Object.freeze({
  title: 256,
  description: 4096,
  footer: 2048,
  fieldName: 256,
  fieldValue: 1024,
  fields: 25,
  /**
   * Embeds par message.
   *
   * discord.js ne l'expose sous aucune constante — vérifié sur ses exports —
   * alors que le découpage d'un lot d'événements en a besoin. Sa place est ici,
   * avec les autres limites de la plateforme, plutôt qu'en dur dans le module
   * qui découpe.
   */
  embeds: 10,
  /** Somme de tous les textes d'un même message. */
  total: 6000,
});

/** Marqueur de coupure. Un caractère, pour ne pas grignoter le budget. */
const ELLIPSIS = '…';

/**
 * Coupe un texte à la limite donnée.
 *
 * Tronquer plutôt que refuser : un embed rejeté par l'API, c'est un message
 * qui n'arrive jamais. La coupure est signalée à l'appelant, qui journalise —
 * un texte amputé en silence est un défaut qu'on ne découvre qu'à l'usage.
 *
 * @returns {{ text: string, truncated: boolean }}
 */
export function clamp(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) {
    return { text, truncated: false };
  }

  return { text: `${text.slice(0, limit - ELLIPSIS.length)}${ELLIPSIS}`, truncated: true };
}
