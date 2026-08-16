import { randomInt } from 'node:crypto';

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

import { AppError } from '../../../core/errors/app-error.js';
import { fromRoot } from '../../../utils/paths.js';

/**
 * Épreuve par image : un code déformé, rendu en PNG.
 *
 * Limite assumée par la spec : un code sur une image est lisible par n'importe
 * quel outil de reconnaissance de caractères. Le but est d'arrêter les bots de
 * spam qui rejoignent en masse, pas un attaquant motivé.
 *
 * Le rendu est SYNCHRONE et bloque la boucle d'événements. Mesuré à 2,5 ms de
 * médiane et 3,3 ms de pire cas sur cent rendus consécutifs : deux cents
 * arrivées simultanées représentent moins d'une seconde, réparties sur des
 * interactions déjà accusées en réception. Aucune sérialisation n'est donc
 * posée — mais un rendu qui dépasse `slow_render_ms` est journalisé, seul moyen
 * de découvrir une machine dix fois plus lente avant que des interactions
 * n'expirent sous les yeux des membres.
 */

/**
 * Famille sous laquelle la police versionnée est enregistrée.
 *
 * Un nom qui n'appartient qu'à nous : demander « DejaVu Sans » laisserait
 * Skia résoudre vers une police système du même nom, et le rendu dépendrait de
 * ce qui est installé sur la machine.
 */
const FONT_FAMILY = 'CubexCaptcha';

export function createImageChallenge({ config, logger }) {
  /** Chemin déjà enregistré, pour ne pas recharger la police à chaque image. */
  let registered = null;

  /**
   * Enregistre la police et rend sa famille.
   *
   * **`registerFromPath()` ne lève pas sur un chemin invalide : il rend
   * `null`.** Sans ce contrôle, un `font_path` erroné passerait inaperçu et le
   * captcha serait rendu dans une police de repli — ou, sur une Debian
   * minimale où aucune police n'est installée, en carrés vides. Le membre
   * échouerait sans comprendre, et rien n'apparaîtrait dans les journaux.
   *
   * Ne pas tenter de vérifier l'enregistrement avec `GlobalFonts.getFamilies()`
   * : cette fonction rend un **Buffer de JSON**, et non un tableau d'objets.
   * Traitée comme un tableau, elle fait conclure à un échec là où il n'y en a
   * pas.
   *
   * Le cache porte sur le chemin : un `/reload` qui en désigne un autre
   * provoque un nouvel enregistrement.
   */
  function useFont() {
    const path = config.get('verification.challenge.image.font_path');

    if (registered === path) return FONT_FAMILY;

    const absolute = fromRoot(path);

    if (GlobalFonts.registerFromPath(absolute, FONT_FAMILY) === null) {
      throw new AppError(`police du captcha introuvable ou illisible : ${path}`, {
        code: 'challenge_font_missing',
        context: { path, resolved: absolute },
        expected: false,
      });
    }

    registered = path;

    return FONT_FAMILY;
  }

  /** Paramètres de rendu, relus à chaque image : ils changent à chaud. */
  const params = () => ({
    width: config.get('verification.challenge.image.width'),
    height: config.get('verification.challenge.image.height'),
    fontSize: config.get('verification.challenge.image.font_size'),
    background: config.get('verification.challenge.image.background'),
    textColor: config.get('verification.challenge.image.text_color'),
    noiseLines: config.get('verification.challenge.image.noise_lines'),
    noiseDots: config.get('verification.challenge.image.noise_dots'),
    distortion: config.get('verification.challenge.image.distortion'),
  });

  /**
   * Tire un code dans l'alphabet configuré.
   *
   * `randomInt` de node:crypto plutôt que `Math.random()` : pas de biais de
   * modulo, et une suite qui ne se prédit pas. Le bruit visuel, lui, garde
   * `Math.random()` — ni l'un ni l'autre n'y change quoi que ce soit.
   */
  function generate() {
    const alphabet = config.get('verification.challenge.alphabet');
    const length = config.get('verification.challenge.code_length');

    let code = '';
    for (let i = 0; i < length; i += 1) code += alphabet[randomInt(alphabet.length)];

    return code;
  }

  /** Dessine le code, puis le bruit par-dessus. */
  function draw(text) {
    const p = params();
    const family = useFont();

    const canvas = createCanvas(p.width, p.height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = p.background;
    ctx.fillRect(0, 0, p.width, p.height);

    ctx.font = `${p.fontSize}px ${family}`;
    ctx.fillStyle = p.textColor;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    // Chaque caractère est posé, tourné et décalé pour lui-même : une
    // déformation appliquée au mot entier se corrige d'une rotation, caractère
    // par caractère elle ne se corrige pas aussi simplement.
    const step = p.width / (text.length + 1);

    for (const [index, character] of [...text].entries()) {
      const angle = (Math.random() - 0.5) * p.distortion;
      const offset = (Math.random() - 0.5) * p.distortion * p.height * 0.4;

      ctx.save();
      ctx.translate(step * (index + 1), p.height / 2 + offset);
      ctx.rotate(angle);
      ctx.fillText(character, 0, 0);
      ctx.restore();
    }

    ctx.strokeStyle = p.textColor;
    ctx.lineWidth = 2;

    for (let i = 0; i < p.noiseLines; i += 1) {
      ctx.beginPath();
      ctx.moveTo(Math.random() * p.width, Math.random() * p.height);
      ctx.lineTo(Math.random() * p.width, Math.random() * p.height);
      ctx.stroke();
    }

    for (let i = 0; i < p.noiseDots; i += 1) {
      ctx.fillRect(Math.random() * p.width, Math.random() * p.height, 2, 2);
    }

    return canvas.toBuffer('image/png');
  }

  /** Normalise une saisie selon les deux bascules de configuration. */
  function normalize(value) {
    let text = String(value ?? '');

    if (config.get('verification.challenge.input.strip_whitespace')) {
      text = text.replace(/\s+/g, '');
    }

    if (!config.get('verification.challenge.input.case_sensitive')) {
      // `toUpperCase()` et non `toLocaleUpperCase()`, dont le résultat dépend
      // de la locale du processus.
      text = text.toUpperCase();
    }

    return text;
  }

  return {
    type: 'image',

    /**
     * Contrôle au démarrage. Un `font_path` erroné refuse le démarrage plutôt
     * que de se découvrir au premier clic d'un membre.
     */
    prepare() {
      useFont();
    },

    /** @returns {{ secret: string, attachment: Buffer }} */
    issue() {
      const secret = generate();

      const started = process.hrtime.bigint();
      const attachment = draw(secret);
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;

      const limit = config.get('verification.challenge.image.slow_render_ms');

      if (elapsed > limit) {
        // La valeur ne dit rien du code tiré : seulement combien de temps la
        // boucle d'événements est restée bloquée.
        logger.warn('rendu du captcha lent', {
          elapsed_ms: Math.round(elapsed),
          limit_ms: limit,
          hint: 'une machine sensiblement plus lente peut faire expirer des interactions',
        });
      }

      return { secret, attachment };
    },

    accepts: (secret, submitted) => normalize(secret) === normalize(submitted),
  };
}
