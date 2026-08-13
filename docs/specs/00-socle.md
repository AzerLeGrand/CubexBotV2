# Socle technique — Phase 0

Spécification du noyau du bot Discord Cubex. Aucun module fonctionnel ne peut être
écrit avant que ce socle soit en place.

**Statut :** figé le 11 août 2026, révisé le 12 août 2026 (voir §15, points fermés).
**Remplace :** `CubexBOT.md` (périmé — décrivait une architecture avec panel Express).

---

## 1. Portée

Ce document couvre le noyau : configuration, secrets, base de données,
journalisation, enregistrement des commandes, moteur d'embeds, registre de purge,
couche Minecraft inerte, chargement des modules.

Il ne couvre aucun comportement fonctionnel. Ceux-ci sont décrits dans les
fichiers `01-*.md` à `06-*.md`.

### Ordre de développement

| Phase | Contenu | Fichier de spec |
|-------|---------|-----------------|
| 0 | Socle | ce document |
| 1 | Vérification | `01-verification.md` |
| 2 | Journalisation Discord | `02-logs-discord.md` |
| 3 | Sanctions et casier | `03-sanctions.md` |
| 4 | Tickets | `04-tickets.md` |
| 5 | Commandes d'embeds | `05-embeds.md` |
| 6 | Journalisation technique | `06-logs-techniques.md` |
| — | Pont Minecraft | reporté, hors v1 |

---

## 2. Contraintes non négociables

1. **Aucune valeur codée en dur.** Tout identifiant, seuil, délai, gabarit,
   couleur ou texte vient d'un fichier de configuration. Un littéral dans le code
   est un défaut, pas un raccourci.
2. **Les secrets vivent dans `.env`, jamais dans les YAML.** L'inverse est
   également vrai : aucun réglage fonctionnel dans `.env`.
3. **Toute erreur est gérée.** Aucune promesse non capturée, aucun appel réseau
   sans traitement d'échec.
4. **L'architecture précède l'écriture.** Un module se conçoit avant de se coder.

---

## 3. Environnement d'exécution

| Élément | Valeur |
|---------|--------|
| Machine | VPS IONOS, `217.160.195.134`, hôte `cubex-bot-discord` |
| Système | Debian 13 (trixie), sans panneau d'hébergement |
| Runtime | Node.js 24 LTS (24.19.0, dépôt NodeSource) |
| Superviseur | pm2 7.0.3, unité systemd `pm2-cubexbot.service` |
| Utilisateur | `cubexbot` |
| Fuseau | `Europe/Paris`, déclaré dans `bot.timezone` |
| Mémoire | 1,8 Go + 2 Go de swap |

Aucun service web n'est exposé. Le pare-feu n'autorise que SSH en entrée.

### Arrêt propre et pm2

**pm2 envoie `SIGINT` par défaut, pas `SIGTERM`, et attend 1600 ms avant
`SIGKILL`.** Ce délai est trop court pour drainer les journaux, exécuter le
checkpoint WAL de SQLite et déconnecter le client Discord.

`ecosystem.config.cjs` déclare donc `kill_signal: 'SIGTERM'` — signal d'arrêt
conventionnel, celui qu'emploiera systemd — et relève `kill_timeout` à **12
secondes**.

Ce budget se décompose en trois étapes plafonnées à 3 secondes chacune :

| Étape | Motif du plafond |
|-------|------------------|
| Client Discord | fermeture du WebSocket, tributaire du réseau |
| Base de données | checkpoint WAL puis fermeture du fichier |
| Journaux | drain des tampons |

Soit 9 secondes au pire, plus 3 de marge pour une machine à 1,8 Go dont une part
du processus peut être en swap. Ce délai n'est subi que si le bot ne sort pas de
lui-même.

**Invariant :** la somme des plafonds d'étape reste strictement inférieure à
`kill_timeout`. Ajouter une quatrième ressource à fermer impose de revoir la
valeur. L'invariant est rappelé dans `ecosystem.config.cjs` et dans le code.

Le gestionnaire d'erreurs écoute `SIGTERM` **et** `SIGINT` : le premier couvre un
arrêt système, le second pm2 sous sa configuration par défaut et l'interruption
clavier en développement. Ces signaux sont un arrêt normal — code de sortie 0,
journalisation en `info`, jamais en `error`.

**Ordre de fermeture : LIFO**, l'inverse de l'inscription. Le drain des journaux,
inscrit d'office en premier, part en dernier et peut donc relater la fermeture de
la base et du client. Chaque ressource s'inscrit par son nom sans que le
gestionnaire ait à la connaître.

**`ecosystem.config.cjs` ne déclare aucun bloc `env`.** `process.loadEnvFile()`
n'écrase pas une variable déjà présente dans l'environnement : un `NODE_ENV` posé
par pm2 l'emporterait silencieusement sur `.env`, et le même dépôt se
comporterait différemment selon son mode de lancement. `.env` reste la source
unique, conformément au §5.7.

### Dépendances principales

- `discord.js` — client Discord
- `better-sqlite3` — base de données
- `js-yaml` — lecture des fichiers de configuration
- `zod` — validation de schéma (**version 4**, la syntaxe d'erreur diffère de la 3)
- `winston`, `winston-transport`, `triple-beam` — journalisation

`.env` est chargé par `process.loadEnvFile()`, natif et stable depuis Node 24.10.
Aucune dépendance `dotenv`.

**Rotation des journaux — paquet écarté.** `winston-daily-rotate-file` n'est pas
utilisé : sans commit depuis février 2024, il épingle `file-stream-rotator`, figé
depuis janvier 2022. Aucun correctif ne serait à attendre si un défaut
apparaissait sous une future version de Node.

La rotation est assurée par un transport écrit dans
`src/core/logging/rotating-file.js` : un descripteur, une vérification de date à
l'écriture, un balayage du dossier au changement de jour et à la construction.
Aucune minuterie — rien à armer, à désarmer, ni à oublier à l'extinction.

Ce transport purge lui-même les fichiers dépassant la rétention. C'est une
exception au registre de purge du §10, assumée : le registre est typé pour du SQL
(`table`, `date_column`, `retention_key`), lui greffer une seconde nature pour un
seul cas d'usage le compliquerait plus qu'il ne le simplifierait. La durée vient
de `config.yml` comme tout le reste.

**Cadence de publication de winston.** Le projet est sain — mainteneur actif,
matrice d'intégration continue montée à Node 22, 24 et 26 en juin 2026,
contributions externes acceptées — mais publie lentement : la 3.19.0 date de
décembre 2025 et les correctifs de l'été 2026 ne sont pas encore sur npm. Sans
effet aujourd'hui ; si un correctif nous devient nécessaire, l'option est
d'épingler un commit.

**Choix de la base — justification.** `node:sqlite`, intégré à Node 24, est classé
*Stability 1.2 — Release candidate* : l'API est stabilisée mais le module n'a pas
reçu le tampon final. Pour un service destiné à tourner des années,
`better-sqlite3` reste préférable.

**Correction d'une estimation trop optimiste.** Une première rédaction annonçait
qu'une bascule ultérieure serait courte. Elle ne le sera pas. La façade de
`src/core/database/` n'isole pas la bibliothèque et n'en a jamais eu
l'intention : `prepare()` rend des objets qui lui appartiennent, et l'instance
brute est exposée. Elle existe pour tenir les réglages d'ouverture et la
fermeture au même endroit, pas pour rendre la bibliothèque interchangeable.

C'est un écart délibéré à ce qui est exigé de `src/core/logging/`, où aucun autre
fichier n'importe `winston`. La différence tient à la surface : un logger
s'utilise par quatre méthodes, une base de données par des objets préparés qui
circulent dans tout le code. Une isolation réelle demanderait une couche
d'abstraction dont le coût dépasse celui de la bascule qu'elle éviterait.

---

## 4. Arborescence

```
src/
  core/
    config/        chargement, validation, rechargement
    database/      connexion, migrations
    logging/       journalisation applicative
    embeds/        moteur de rendu
    purge/         registre et tâche planifiée
    commands/      enregistrement et routage des commandes slash
    loader/        découverte et chargement des modules
    errors/        types d'erreur et gestionnaire global
  modules/         un dossier par module fonctionnel
  minecraft/       interface et implémentation inerte
  utils/         paths, moteur de substitution
config/
  config.yml       réglages
  messages.yml     textes
  embeds.yml       gabarits d'affichage
migrations/        fichiers SQL numérotés
data/              base SQLite (exclu de Git)
logs/              journaux applicatifs (exclu de Git)
docs/specs/        ce document et les suivants
.claude/rules/     règles Claude Code
CLAUDE.md
.env               secrets (exclu de Git)
.env.example       modèle versionné
```

### Forme d'un module

Chaque dossier sous `src/modules/` expose la même interface :

| Export | Obligatoire | Rôle |
|--------|-------------|------|
| `name` | oui | identifiant du module, **égal au nom du dossier** |
| `commands` | non | commandes slash fournies |
| `events` | non | écouteurs d'événements Discord |
| `migrations` | non | fichiers SQL du module |
| `retention` | non | déclarations pour le registre de purge |
| `init(ctx)` | non | initialisation, reçoit le contexte du noyau |

`init` est facultative : un module purement déclaratif — des migrations et des
déclarations de rétention, sans état à monter — n'a pas à écrire une fonction
vide pour la forme.

`name` doit égaler le nom du dossier. Il porte l'identité des migrations et des
commandes ; un écart les ferait diverger en silence.

Le noyau découvre les modules automatiquement. Aucune liste à maintenir à la main.

**Un module présent dans `src/modules/` qui échoue à s'importer arrête le
démarrage.** Il n'est jamais ignoré.

Cette règle n'est pas une préférence : le traitement des migrations distingue un
module retiré d'un module actif sur la seule absence de sources. Un module
présent mais non importable produirait la même absence, et ses migrations
cesseraient de s'appliquer sans que rien ne le signale. Voir §6.

Cette règle est distincte de la désactivation du §5.5 : un module dont une
référence Discord est introuvable reste chargé, et ses migrations s'appliquent.

---

## 5. Configuration

### 5.1 Séparation par nature

Trois fichiers, tous versionnés (dépôt privé) :

- **`config.yml`** — réglages techniques : identifiants, seuils, délais, bascules.
- **`messages.yml`** — tous les textes destinés aux utilisateurs.
- **`embeds.yml`** — gabarits d'affichage.

Aucun texte destiné à un utilisateur ne figure dans `config.yml` ni dans le code.

### 5.2 Identifiants Discord

**Règle absolue : tout identifiant Discord est une chaîne de caractères.**

Un identifiant Discord fait 18 ou 19 chiffres. Le plus grand entier représentable
exactement en JavaScript est de l'ordre de 9 × 10¹⁵, soit 16 chiffres. Écrit sans
guillemets, l'identifiant est lu comme un nombre et ses derniers chiffres sont
corrompus silencieusement — le bot mentionnerait alors un rôle inexistant sans
lever d'erreur.

C'est la panne qui a arrêté l'ancien bot :
`tickets.categories.0.ping_role_ids.0: Expected string, received number`.

La validation doit :

1. Rejeter tout identifiant fourni comme nombre.
2. Produire un message explicite indiquant qu'il faut des guillemets, avec le
   chemin complet de la clé fautive.
3. Vérifier le format : 17 à 20 chiffres.

```yaml
# Correct
roles:
  member: "1234567890123456789"

# Incorrect — démarrage refusé
roles:
  member: 1234567890123456789
```

### 5.3 Détection de secrets

Le démarrage est refusé si une clé ou une valeur d'un fichier YAML ressemble à un
secret : jeton Discord, mot de passe, clé d'API. Motifs à détecter au minimum sur
les noms de clés : `token`, `password`, `secret`, `api_key`, `apikey`.

### 5.4 Validation au démarrage

- La validation porte sur l'intégralité des trois fichiers.
- **Toutes** les erreurs sont collectées et affichées ensemble, jamais la première
  seule.
- Une erreur de validation arrête le bot. Un bot arrêté vaut mieux qu'un bot
  tournant sur une configuration incohérente.

### 5.5 Vérification des références Discord

Après connexion, chaque identifiant de rôle, salon ou catégorie est vérifié auprès
de l'API Discord.

| Situation | Comportement |
|-----------|--------------|
| Référence introuvable | Avertissement journalisé, fonctionnalité concernée désactivée |
| Référence valide | Aucun message |

Le bot ne s'arrête pas. Une fonctionnalité désactivée pour cette raison répond aux
commandes qu'elle est indisponible, sans planter.

### 5.6 Rechargement à chaud

Commande slash de rechargement, réservée aux rôles **Owner** et **Admin**
(la liste reste configurable).

Déroulement :

1. Relecture des trois fichiers.
2. Validation complète.
3. Si valide : la nouvelle configuration remplace l'ancienne, confirmation
   éphémère au demandeur.
4. Si invalide : **l'ancienne configuration est conservée en mémoire**, le bot
   continue de tourner, et la liste des erreurs est renvoyée au demandeur.

### 5.7 Secrets (`.env`)

Contenu attendu :

| Clé | Rôle |
|-----|------|
| `DISCORD_TOKEN` | jeton de l'application Discord |
| `DISCORD_CLIENT_ID` | identifiant de l'application |
| `NODE_ENV` | `production` ou `development` |

`.env` est exclu de Git. `.env.example` est versionné avec des valeurs vides.
Le démarrage est refusé si une clé attendue est absente.

---

## 6. Base de données

- Moteur : `better-sqlite3`, fichier dans un chemin donné par `config.yml`.
- Mode journal WAL, **vérifié après application** et non seulement demandé : sur
  un montage réseau, SQLite refuse WAL et retombe silencieusement sur le journal
  par défaut. Le bot tournerait alors avec des garanties de durabilité qu'il
  croit avoir.
- Clés étrangères activées.
- `synchronous = NORMAL` en dur. Relève de la seconde exception de `CLAUDE.md` :
  le rendre configurable permettrait d'écrire `OFF` et de perdre des écritures
  sur coupure — configurer une garantie revient à permettre de la contourner.
- `busy_timeout` dans `config.yml` : c'est un réglage d'exploitation, pas une
  garantie. Sur un disque lent, la valeur par défaut peut devenir insuffisante.

### Migrations

- Fichiers SQL numérotés dans `migrations/`, nommés `001_description.sql`.
- Une table interne enregistre les migrations appliquées. Elle porte une colonne
  **`owner`**, et sa clé primaire est `(owner, number)` : chaque module a sa
  propre séquence, `core/001` et `tickets/001` coexistent. Sans cela, le premier
  module écrit devrait connaître la numérotation du noyau pour ne pas la
  percuter.
- Application automatique au démarrage, dans l'ordre, en transaction.
- Une migration en échec arrête le démarrage.
- Les migrations ne sont jamais modifiées après application : on en ajoute une
  nouvelle.

### Détection de divergence

Trois cas arrêtent le démarrage :

| Cas | Motif |
|-----|-------|
| Fichier appliqué puis disparu | l'historique ne correspond plus au dépôt |
| Fichier retouché après application | l'empreinte diffère |
| Numéro glissé sous un numéro déjà appliqué | scénario de fusion de branches — la migration perdante ne s'appliquerait jamais et personne ne le verrait |

Un fichier `.sql` au nom non conforme est **refusé, pas ignoré**. Ignoré, il ne
s'appliquerait jamais en silence, ce qui est le pire des traitements.

**L'empreinte normalise les fins de ligne avant hachage.** Git livre le même
fichier en CRLF sous Windows et en LF sur le VPS ; sans cette normalisation,
toutes les migrations paraîtraient modifiées au premier déploiement et le bot
refuserait de démarrer.

Chaque module déclare ses propres fichiers de migration.

### Ordre d'application

`core` en premier, puis les autres propriétaires par ordre de nom en
**comparaison binaire** — jamais `localeCompare`, dont le résultat dépend de
l'ICU chargée et différerait entre un poste Windows et le VPS. L'ordre ne dépend
jamais de la découverte du système de fichiers.

**Aucune déclaration de dépendance entre modules.** Leur ordre est déterministe
mais arbitraire : rien ne garantit qu'il corresponde à un ordre de dépendance. La
règle qui rend cette absence tenable est qu'une migration de module ne référence
que ses propres tables ou celles du noyau. Aucune table des phases 1 à 6 n'y
contrevient. Si une table partagée devenait nécessaire, elle appartiendrait au
noyau.

### Module retiré

La détection de divergence distingue sur la présence du **propriétaire**, non sur
celle du fichier seul. Un propriétaire pour lequel aucune source n'est fournie
produit un avertissement journalisé, pas une erreur — sinon retirer ou désactiver
un module rendrait le démarrage impossible.

**Les tables d'un module retiré ne sont jamais supprimées.** Un retrait peut être
temporaire, et les données — tickets archivés, transcriptions — n'ont pas à
disparaître parce qu'on a commenté un dossier. Le nettoyage est une décision
humaine.

« Source fournie » dépend de la présence du module sur disque, jamais d'un état
d'activation. C'est ce qui rend indispensable la règle du §4 : un module présent
mais non importable arrête le démarrage.

---

## 7. Journalisation applicative

- **Format : JSON**, une entrée par ligne.
- Sortie : fichiers dans `logs/`, plus la console si `NODE_ENV=development`.
- Rotation quotidienne.
- Rétention configurable.
- Niveaux : `error`, `warn`, `info`, `debug`.

Champs minimaux par entrée : horodatage ISO 8601, niveau, module, message,
contexte structuré, pile d'appel en cas d'erreur.

Le format JSON est retenu parce qu'il permet un filtrage propre et facilitera le
relais vers Discord en phase 6.

---

## 8. Commandes

### 8.1 Type et enregistrement

- **Commandes slash uniquement.** Les commandes à préfixe sont exclues : elles
  exigent l'intent Message Content sans contrepartie et constituent une pratique
  obsolète.
- Enregistrement **au niveau du serveur**, pas globalement : la propagation est
  instantanée, contre jusqu'à une heure en global.

### 8.2 Permissions

Les permissions sont définies **par configuration**, non par le système natif de
Discord. Chaque commande porte une liste de rôles autorisés.

```yaml
commands:
  reload:
    allowed_roles:
      - "ID_OWNER"
      - "ID_ADMIN"
```

Une liste **vide est refusée à la validation**. Ouvrir une commande à tous impose
d'écrire explicitement le littéral `"public"` :

```yaml
commands:
  ping:
    allowed_roles: "public"
```

> Écart assumé par rapport à une première rédaction qui traitait la liste vide
> comme une ouverture à tous. Toutes les commandes des phases 1 à 5 sont
> réservées au staff : une liste vidée par erreur d'édition ouvrirait `/ban` à
> `@everyone` sans le moindre message. Même profil de panne que l'identifiant
> sans guillemets — silencieux, et bien plus coûteux.

### 8.3 Refus

Une commande refusée répond **en message éphémère au demandeur uniquement**.
Aucune trace n'est envoyée dans les salons de logs.

---

## 9. Moteur d'embeds

Tous les messages du bot passent par un gabarit défini dans `embeds.yml`. Aucun
texte ni couleur n'est écrit dans le code.

### Couleurs

| Clé | Libellé | Valeur | Usage |
|-----|---------|--------|-------|
| `brand` | Marque | `#F60321` | messages publics, communications officielles |
| `success` | Succès | `#57F287` | opération réussie |
| `error` | Erreur | `#E67E22` | échec, refus |
| `info` | Information | `#5865F2` | neutre |

**Les clés sont en anglais et constituent une interface publique** : le module
d'embeds (phase 5) les expose telles quelles au staff, qui les saisit dans une
modale. Ce sont les clés exactes attendues dans `embeds.yml`. La colonne
« Libellé » n'est là que pour la lecture de ce document.

Le rouge de marque est extrait du logo Cubex. L'erreur est en orange
volontairement : le rouge Discord standard (`#ED4245`) est trop proche du rouge de
marque pour être distingué d'un coup d'œil.

### Pied de page

Commun à tous les embeds : le texte `Cubex` et un horodatage.

### Variables

Un gabarit accepte des variables substituées à l'exécution.

**Syntaxe : accolade simple, nom en anglais** — `{username}`, `{number}`,
`{reason}`. Les noms suivent la même convention que les clés de configuration.

Le moteur de substitution est **partagé** : il s'applique aux gabarits
d'`embeds.yml`, aux textes de `messages.yml` et à certaines valeurs de
`config.yml` (gabarit de nommage des salons de ticket, notamment). Ce n'est donc
pas un service exclusif du moteur d'embeds.

Une variable non fournie doit produire une erreur journalisée, pas un affichage
vide silencieux.

---

## 10. Registre de purge

Aucun module n'écrit sa propre logique de suppression. Chaque module déclare :

| Champ | Rôle |
|-------|------|
| `table` | table concernée |
| `date_column` | colonne d'horodatage servant au calcul |
| `retention_key` | clé de `config.yml` donnant la durée |

Une tâche planifiée parcourt le registre et supprime les lignes dépassant la durée
déclarée.

**`date_column` doit contenir un horodatage ISO 8601 strict en TEXT**, avec le
`T` séparateur, et le registre le vérifie au premier passage sur chaque table.
Deux pièges le justifient : SQLite ordonne les types avant les valeurs
(`NULL < INTEGER < TEXT`), donc une colonne en entier Unix rendrait la condition
toujours vraie et viderait la table ; et `datetime('now')` produit un espace là
où `toISOString()` produit un `T`, or l'espace précède le `T` dans l'ordre
binaire — la purge serait décalée d'une journée, tous les jours, sans que rien ne
le signale.

Les horodatages sont donc écrits par le code via `toISOString()`. `datetime('now')`
est proscrit dans les migrations.

- **Exécution : 4h00**, dans le fuseau défini par `bot.timezone`
  (`Europe/Paris`). Creux de fréquentation.
- Fréquence : quotidienne.
- **Compte rendu** : nombre de lignes supprimées par table, journalisé en fichier
  (phase 0). Le relais vers le salon `bot` sera ajouté en phase 6.
- Une erreur sur une table n'interrompt pas les autres.

### Durées de rétention retenues

| Catégorie | Durée | Motif |
|-----------|-------|-------|
| Contenu de messages supprimés ou modifiés | 30 jours | donnée la plus intrusive et la moins durablement utile |
| Événements structurels (arrivées, rôles, salons) | 90 jours | peu sensible, utile à la reconstitution |
| Sanctions | **sans limite** | mémoire de modération, seule donnée que Discord ne conserve pas (voir `03-sanctions.md`) |
| Logs techniques VPS | 14 jours | diagnostic uniquement |

Toutes les durées sont dans `config.yml`.

### Droit à l'effacement

Une commande de suppression sur demande d'un membre doit être possible dès la
conception. Les modalités relèvent du volet légal, mais l'architecture doit
permettre de retrouver et supprimer toutes les données d'un identifiant Discord
donné, à travers l'ensemble des tables.

---

## 11. Couche Minecraft

Le pont vers le serveur Minecraft est **reporté hors v1**. Le socle prévoit
néanmoins son emplacement pour éviter une réécriture ultérieure.

- Une interface définit les méthodes attendues (lecture des grades LuckPerms,
  statistiques justCombat, liaison de compte).
- Une implémentation inerte les fournit toutes, chacune signalant que la
  fonctionnalité est indisponible.
- `config.yml` contient une section `minecraft:` avec `enabled: false`.
- Toute commande qui en dépend répond que la fonctionnalité n'est pas active.

### Contexte technique déjà établi

Ces éléments sont acquis et ne seront pas réétudiés :

- Le serveur tourne sous **Canvas 26.2**, fork de Folia. Tout plugin ajouté doit
  déclarer `folia-supported: true`, sinon il ne sera pas chargé.
- **LuckPerms** stocke en MariaDB. Lecture seule : l'API REST est inutile, une
  lecture SQL directe suffit. Le grade réel se lit dans
  `luckperms_user_permissions` via les nœuds `group.<nom>` — la colonne
  `primary_group` de `luckperms_players` n'est pas fiable.
- **justCombat** est actuellement en SQLite local. Une migration vers MariaDB est
  requise, sans outil intégré : export et import manuels. Le pilote JDBC MariaDB
  doit être présent, faute de quoi le plugin retombe silencieusement sur SQLite.
- Les statistiques disponibles : kills, morts, dégâts infligés, dégâts subis,
  streak courant, meilleur streak. Le nom réel de la table est à vérifier après
  migration : la documentation du plugin se contredit entre `player_statistics` et
  `jc_statistics`.
- Aucune API réseau côté plugin. Les placeholders PlaceholderAPI ne fonctionnent
  qu'en jeu.
- Le transport entre OVH et IONOS passe par Internet public : chiffrement TLS ou
  tunnel requis, accès restreint à l'IP du VPS.

---

## 12. Intents Discord

| Intent | Nécessaire pour | Phase |
|--------|-----------------|-------|
| `Guilds` | fonctionnement de base | 0 |
| `GuildMembers` (privilégié) | arrivées, départs, changements de rôle | 1 |
| `GuildMessages` | républication du message de vérification, puis événements de message | **1** |
| `MessageContent` (privilégié) | contenu des messages supprimés ou modifiés | 2 |
| `GuildVoiceStates` | journalisation vocale | 2 |
| `AutoModerationExecution` | déclenchements AutoMod | 3 |
| `GuildModeration` | bannissements et levées de bannissement | 2 |

Les intents privilégiés s'activent dans le portail développeur. Depuis le
10 juin 2026, Discord applique un seuil basé sur le nombre d'utilisateurs : les
applications accessibles à moins de 10 000 utilisateurs ne sont pas soumises à
procédure de revue. Cubex est très en dessous.

Seuls les intents réellement utilisés par les phases livrées sont déclarés.

---

## 13. Salons de journalisation

Structure validée, à renseigner en configuration. Chaque type d'événement pointe
vers un salon **individuellement** : la répartition ci-dessous n'est qu'une valeur
par défaut.

| Salon | Contenu | Accès |
|-------|---------|-------|
| Messages | suppressions, modifications, purges | staff |
| Vocal | connexions, déconnexions, déplacements | staff |
| Membres | arrivées, départs, pseudos, avatars | staff |
| Rôles | attributions, retraits, modifications de rôles | staff |
| Serveur | salons, permissions, webhooks, émojis | staff |
| Modération | timeouts, expulsions, bans, AutoMod | staff |
| Tickets | ouvertures, fermetures, transcriptions | staff |
| Bot | démarrages, erreurs, rechargements | admin |
| Système VPS | SSH, fail2ban, mises à jour | admin |

Deux exigences transverses :

- **Groupement des événements** sur les salons à fort volume (Messages, Vocal)
  pour ne pas heurter les limites de débit de Discord.
- **Exclusion configurable** : le bot ne doit pas journaliser ses propres
  écritures dans les salons de logs.

---

## 14. Hiérarchie des rôles du serveur

Pour référence lors de la configuration :

**Hiérarchie staff** — Owner, Admin, Developer, Senior Moderator, Mod, Trainee.
`Staff` est un rôle commun d'affichage, attribué à toute l'équipe de modération et
de développement.

**Rôles de support** — Game Support, Appeal Support, Store Support,
`Bug / Tech Support`, Partner Support, Recruitment Support.
Servent au routage des tickets.

**Rôles communautaires** — Partner, Media, Cu'Boost, Ultra, Elite, Pro, Member.

**Prérequis Discord :** le rôle du bot doit être positionné **au-dessus** de tous
les rôles qu'il doit attribuer, `Member` compris. Manipulation à effectuer côté
Discord.

---

## 15. Points ouverts

À trancher avant ou pendant l'implémentation :

1. **Identifiants réels** des rôles et salons — à collecter après suppression des
   rôles orphelins des anciens bots (`c-link`, `cubex bot`, `cubex link`, et les
   deux rôles d'intégration verrouillés).
2. **Valeurs par défaut restant à fixer**, réparties dans les modules :
   nombre de tentatives de vérification, seuil de bascule vers le fichier joint,
   fenêtre de groupement, entrées par page du casier, délai entre deux ouvertures
   de ticket, plafond de messages techniques par minute.

### Règle sur les valeurs par défaut

`.default()` dans le schéma est **réservé aux réglages purement techniques**.
Sont obligatoires, sans valeur par défaut :

- tout identifiant Discord ;
- toute liste `allowed_roles` ;
- toute durée de rétention.

Un défaut silencieux sur une rétention signifie une donnée personnelle conservée
plus longtemps que prévu sans que personne ne le sache.

### Points fermés

| Point | Décision | Référence |
|-------|----------|-----------|
| Rétention des sanctions | sans limite | `03-sanctions.md` §6 |
| Rétention des événements de modération | `logs.retention.structural_days` | `02-logs-discord.md` §9 |
| Phase de l'intent `GuildMessages` | avancé en phase 1 | `01-verification.md` §3 |
| Relais du compte rendu de purge | salon `bot`, phase 6 | `06-logs-techniques.md` §2 |
| Syntaxe des variables | accolade simple, noms anglais, moteur partagé | §9 |
| Clés de couleurs | anglaises, interface publique | §9 |
| `allowed_roles` vide | refusé, littéral `"public"` requis | §8.2 |
| Fenêtre de groupement | deux clés indépendantes | `02` §5 et `06` §5 |
| Fuseau horaire | clé unique `bot.timezone`, jamais par module | §3 et §10 |
| Bibliothèque de journalisation | `winston`, rotation par transport maison | §3 |

**Contrainte conservée malgré la décision :** le module de configuration
n'importe jamais le logger. Il émet des événements et reçoit un logger injecté
après construction, faute de quoi le cycle `config → logging → config` est
inévitable — le §5.5 impose de journaliser depuis la validation. La même règle
vaut pour le gestionnaire d'erreurs.

`src/core/logging/` expose sa propre interface. Aucun autre fichier du projet
n'importe `winston`.

### Fuseau horaire unique

`bot.timezone` vaut pour **tout ce que le bot calcule ou formate lui-même** :
rotation des fichiers de journaux, purge quotidienne, dates écrites dans le corps
d'un embed (date d'une sanction au casier, horodatage d'une transcription),
noms de fichiers datés.

**Exception : le champ `timestamp` natif d'un embed.** Discord l'affiche dans le
fuseau de chaque lecteur, et le bot n'a aucune prise dessus. C'est le comportement
souhaitable pour un contenu lu par des humains, et il est conservé tel quel. Une
première rédaction de cette section rangeait les horodatages d'embeds sous
`bot.timezone` ; c'était une erreur, la plateforme s'en charge.

La règle porte donc sur ce que le bot formate, pas sur ce qu'il délègue.

Un fuseau déclaré par module produirait des dates incohérentes entre deux
affichages du même événement, et pourrait faire tomber la rotation d'un fichier
et la purge des lignes qu'il décrit sur deux journées civiles différentes.

La valeur vient de la configuration et non du réglage système, pour que le poste
de développement et le VPS se comportent à l'identique.
