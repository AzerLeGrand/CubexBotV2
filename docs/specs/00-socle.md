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

### Dépendances principales

- `discord.js` — client Discord
- `better-sqlite3` — base de données
- `js-yaml` — lecture des fichiers de configuration
- `zod` — validation de schéma
- bibliothèque de journalisation (à arbitrer à l'implémentation)

**Choix de la base — justification.** `node:sqlite`, intégré à Node 24, est classé
*Stability 1.2 — Release candidate* : l'API est stabilisée mais le module n'a pas
reçu le tampon final. Pour un service destiné à tourner des années,
`better-sqlite3` reste préférable. Les deux exposent une API synchrone comparable,
une bascule ultérieure serait courte si `node:sqlite` passe stable.

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
    errors/        types d'erreur et gestionnaire global
  modules/         un dossier par module fonctionnel
  minecraft/       interface et implémentation inerte
  utils/
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

| Export | Rôle |
|--------|------|
| `name` | identifiant du module |
| `commands` | commandes slash fournies |
| `events` | écouteurs d'événements Discord |
| `migrations` | fichiers SQL du module |
| `retention` | déclarations pour le registre de purge |
| `init(ctx)` | initialisation, reçoit le contexte du noyau |

Le noyau découvre les modules automatiquement. Aucune liste à maintenir à la main.

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

- Moteur : `better-sqlite3`, fichier dans `data/`.
- Mode journal WAL.
- Clés étrangères activées.

### Migrations

- Fichiers SQL numérotés dans `migrations/`, nommés `001_description.sql`.
- Une table interne enregistre les migrations appliquées (numéro, nom,
  horodatage).
- Application automatique au démarrage, dans l'ordre, en transaction.
- Une migration en échec arrête le démarrage.
- Les migrations ne sont jamais modifiées après application : on en ajoute une
  nouvelle.

Chaque module déclare ses propres fichiers de migration.

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

1. **Bibliothèque de journalisation** — à arbitrer selon l'empreinte mémoire.
   Contrainte de conception : le module de configuration **n'importe jamais** le
   logger. Il émet des événements et reçoit un logger injecté après
   construction, faute de quoi le cycle `config → logging → config` est
   inévitable (le §5.5 impose de journaliser depuis la validation).
2. **Identifiants réels** des rôles et salons — à collecter après suppression des
   rôles orphelins des anciens bots (`c-link`, `cubex bot`, `cubex link`, et les
   deux rôles d'intégration verrouillés).
3. **Valeurs par défaut restant à fixer**, réparties dans les modules :
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

### Fuseau horaire unique

`bot.timezone` vaut pour tout le bot : rotation des fichiers de journaux, purge
quotidienne, horodatages des embeds, dates du casier, transcriptions de tickets.

Un fuseau déclaré par module produirait des dates incohérentes entre deux
affichages du même événement, et pourrait faire tomber la rotation d'un fichier
et la purge des lignes qu'il décrit sur deux journées civiles différentes.

La valeur vient de la configuration et non du réglage système, pour que le poste
de développement et le VPS se comportent à l'identique.
