# Cubex Bot

Bot Discord de modération, journalisation et support pour le serveur Minecraft
Cubex (`fr.cubex.club`).

## Pile

Node.js 24 LTS, ESM (`"type": "module"`). discord.js, better-sqlite3, js-yaml,
**zod 4** (la syntaxe d'erreur diffère de zod 3). Supervision **systemd** sur un
VPS Debian 13, unité `cubex-bot.service`.

`.env` est chargé par `process.loadEnvFile()`, natif et stable depuis Node 24.10.
Pas de dépendance `dotenv`.

## Commandes

```bash
npm start          # démarrage
npm run dev        # démarrage avec rechargement (node --watch)
npm test           # tests
```

## Déploiement

Sur le VPS, dans cet ordre :

```bash
git pull
npm ci
npm test                              # sur la machine cible, jamais seulement ici
sudo systemctl restart cubex-bot
tail -f logs/cubex-$(date +%F).log
```

`npm ci` et non `npm install` : il installe exactement le `package-lock.json`
versionné, là où `install` peut résoudre une version différente et faire diverger
le VPS du poste.

`npm test` s'exécute **sur la machine cible** avant le redémarrage. C'est le seul
endroit où une divergence de plateforme se prouve — Windows et Debian ne
comparent, ne trient et ne résolvent pas les chemins de la même façon.

### Où lire ce qui s'est passé

**Le journal du jour, `logs/cubex-AAAA-MM-JJ.log`, pas `journalctl`.**

En production `NODE_ENV=production` coupe la sortie console : la journalisation
n'écrit qu'en fichier JSON. `journalctl -u cubex-bot` ne montre donc que ce qui
part sur stderr, c'est-à-dire les seuls **blocages de démarrage** :

| Ce qu'on cherche | Où le lire |
|------------------|------------|
| Secrets manquants, configuration invalide, manifeste illisible | `journalctl -u cubex-bot` |
| Connexion à Discord refusée, intent privilégié non coché | `journalctl -u cubex-bot` |
| Résumé d'une défaillance fatale (sortie 1) | `journalctl -u cubex-bot` |
| **Tout le reste** — démarrage réussi, capacités désactivées, événements, erreurs d'exploitation | `logs/cubex-$(date +%F).log` |

Un bot qui ne démarre pas du tout : `journalctl` en premier. Un bot qui tourne
mais ne fait pas ce qu'on attend : le fichier, toujours.

### Unité systemd

`deploy/cubex-bot.service` est la copie versionnée de l'unité en production.
Toute modification se fait des deux côtés, puis `sudo systemctl daemon-reload`.

**`TimeoutStopSec` doit rester strictement supérieur à la somme des plafonds
d'étape de la séquence d'arrêt** (`DEFAULT_STEP_TIMEOUT_MS`, dans
`src/core/errors/handler.js`). En dessous, systemd envoie SIGKILL au milieu de la
fermeture et le bot perd ses dernières écritures. Ajouter une étape de fermeture
impose de revoir la valeur des deux côtés.

## Règle absolue : aucune valeur codée en dur

Tout identifiant, seuil, délai, gabarit, couleur ou texte destiné à un
utilisateur vient d'un fichier de configuration. Un littéral dans le code est un
défaut, jamais un raccourci.

- `config/config.yml` — réglages techniques
- `config/messages.yml` — textes destinés aux utilisateurs
- `config/embeds.yml` — gabarits d'affichage
- `.env` — secrets uniquement, jamais de réglage fonctionnel

Ne jamais écrire un secret dans un fichier YAML. Ne jamais écrire un réglage
fonctionnel dans `.env`.

### Les deux seules exceptions

Une valeur reste en dur dans un seul cas : quand la configurer serait une fausse
configurabilité. Deux formes.

**Elle est nécessaire avant que la configuration soit lisible.** Les messages
d'erreur du chargeur, le plafond de drain du gestionnaire d'erreurs. Une clé que
le code ne pourrait pas lire au moment où il en a besoin ne configure rien.

**La configurer permettrait de contourner ce qu'elle protège.** Les motifs de
détection de secrets : les rendre réglables depuis le fichier qu'ils surveillent
reviendrait à pouvoir les désactiver depuis l'endroit qu'ils protègent.

Tout le reste vient de la configuration. En cas de doute, la valeur est
configurable.

## Identifiants Discord

**Toujours des chaînes de caractères, jamais des nombres.** Un identifiant
Discord fait 18 à 19 chiffres, au-delà de ce que JavaScript représente
exactement : lu comme un nombre, il est corrompu silencieusement.

C'est la panne qui a arrêté la version précédente du bot.

## Conventions

- Modules ES, `import`/`export`, pas de `require`.
- Toute erreur est gérée : aucune promesse non capturée, aucun appel réseau sans
  traitement d'échec.
- Commentaires en français, sur le pourquoi plutôt que sur le quoi.
- Commandes slash uniquement, enregistrées au niveau du serveur.
- Permissions par liste de rôles en configuration, pas par le système natif de
  Discord.
- Une commande refusée répond en message éphémère au demandeur seul.

## Structure

```
src/core/       config, base de données, logs, embeds, purge, commandes, erreurs
src/modules/    un dossier par module fonctionnel
src/minecraft/  interface et implémentation inerte (pont reporté hors v1)
config/         fichiers YAML
migrations/     fichiers SQL numérotés
data/           base SQLite (hors Git)
logs/           journaux JSON (hors Git)
```

Chaque module de `src/modules/` exporte : `name`, `commands`, `components`,
`events`, `migrations`, `retention`, `erasure`, `capabilities`, `init(ctx)`,
`ready(ctx)`. Le noyau les découvre automatiquement, aucune liste à maintenir.

`init(ctx)` monte le module avant la connexion ; `ready(ctx)` fait ce qui exige
l'API Discord, après la vérification des références et **au seul démarrage** —
un `/reload` ne le rejoue pas. Un écouteur déclare `execute(ctx, ...args)` : le
contexte vient en premier, les arguments d'un événement Discord étant
variadiques. Un composant déclare `execute(interaction, ctx, args)`, comme une
commande, et son identifiant persistant vient d'`encodeCustomId()`.

Il peut poser à côté un `manifest.js` facultatif, qui déclare `schema` — le
fragment de `config.yml` qui lui appartient, validé au même titre que le noyau —
et `intents`. Il est lu avant la configuration : il déclare, il ne fait rien
d'autre. Seul import du noyau autorisé, les primitives de schéma — un identifiant
Discord passe par `snowflake()`, jamais par un `z.string()` nu.

## Spécifications

Les specs détaillées sont dans `docs/specs/`, un fichier par phase. Les lire à la
demande, elles ne sont pas chargées automatiquement.

| Phase | Fichier | Contenu |
|-------|---------|---------|
| 0 | `00-socle.md` | noyau, configuration, base, logs, embeds, purge |
| 1 | `01-verification.md` | captcha à l'entrée du serveur |
| 2 | `02-logs-discord.md` | journalisation des événements Discord |
| 3 | `03-sanctions.md` | sanctions et casier |
| 4 | `04-tickets.md` | système de support |
| 5 | `05-embeds.md` | commandes de publication d'embeds |
| 6 | `06-logs-techniques.md` | relais des logs bot et VPS vers Discord |

L'ordre de développement est celui des phases. Le socle conditionne tout le reste.

## Méthode

Concevoir avant d'écrire. Pour toute tâche non triviale, présenter le plan et
attendre validation avant de produire le code complet.

Signaler toute incohérence relevée entre les specs, la configuration et le code,
même sans qu'on l'ait demandé.

<!-- Ne pas ajouter ici le détail des specs : elles vivent dans docs/specs/ et
     seraient rechargées à chaque session pour rien. Garder ce fichier sous
     200 lignes. -->
