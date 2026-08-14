# Polices

Ressources non-code versionnées dans le dépôt.

## Pourquoi une police est versionnée

Aucune police n'est garantie présente sur une installation Debian minimale. Le
rendu du captcha de la phase 1 en exige une : la laisser au système ferait
échouer le rendu sur le VPS alors qu'il fonctionne sur le poste de
développement, et l'écart ne se verrait qu'à la première image produite.

Le chemin est configurable — `verification.challenge.image.font_path` — et jugé
de la même façon sur les deux plateformes.

## DejaVuSans-Bold.ttf

| | |
|---|---|
| Version | DejaVu 2.37 |
| Source | `https://github.com/dejavu-fonts/dejavu-fonts/releases/download/version_2_37/dejavu-fonts-ttf-2.37.zip` |
| Taille | 705 684 octets |
| SHA-256 | `e6476c1b80502924294eed40894c5b18e06c181444ca953e5334262df9c27724` |
| Licence | `LICENSE`, extrait de la même archive |

L'empreinte est notée pour qu'une montée de version reste vérifiable : un
fichier remplacé sans que cette ligne bouge est un fichier dont personne ne sait
plus d'où il vient.

### Pourquoi celle-ci

Le trait gras survit au bruit et à la déformation, et les glyphes sont
suffisamment différenciés pour qu'un membre ne se trompe pas de caractère —
c'est l'échec le plus courant d'un captcha, bien avant la fraude.

**Roboto Bold a été écartée malgré une licence plus standard** (OFL 1.1) : son
seul artefact publié en amont est une police **variable**,
`Roboto[wdth,wght].ttf`, et `googlefonts/roboto-3-classic` ne contient aucun
TTF. Une police variable enregistrée dans un canvas peut retomber sur son
instance par défaut, de poids 400 : le captcha perdrait sa graisse sans que rien
ne le signale, et le défaut ne se verrait qu'à l'œil, sur l'image.

### Licence

Bitstream Vera Fonts Copyright, complétée pour les glyphes Arev. Elle autorise
la reproduction et la distribution, y compris au sein d'un logiciel vendu, à la
condition de joindre la notice de copyright et de permission — d'où le fichier
`LICENSE` à côté. Elle interdit la vente de la police seule et impose un
renommage en cas de modification des glyphes.
