# Cubex Bot

Bot Discord de modération, journalisation et support pour le serveur Minecraft
Cubex (`fr.cubex.club`).

## Pile

Node.js 24 LTS, ESM (`"type": "module"`). discord.js, better-sqlite3, js-yaml,
**zod 4** (la syntaxe d'erreur diffère de zod 3). Supervision pm2 sur un VPS
Debian 13.

`.env` est chargé par `process.loadEnvFile()`, natif et stable depuis Node 24.10.
Pas de dépendance `dotenv`.

## Commandes

```bash
npm start          # démarrage
npm run dev        # démarrage avec rechargement (node --watch)
npm test           # tests
```

Sur le VPS : `pm2 restart cubex-bot`, `pm2 logs cubex-bot`.

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

Chaque module de `src/modules/` exporte : `name`, `commands`, `events`,
`migrations`, `retention`, `init(ctx)`. Le noyau les découvre automatiquement,
aucune liste à maintenir.

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
