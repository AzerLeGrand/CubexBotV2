# Module journalisation Discord — Phase 2

Enregistrement et restitution des événements du serveur Discord. Le module le plus
volumineux de la v1.

**Statut :** figé le 11 août 2026, révisé le 12 puis le 18 août 2026.
**Prérequis :** socle (`00-socle.md`) opérationnel.

> Révision du 18 août 2026, à l'écriture du lot 1. Trois intents manquaient, un
> événement était compté deux fois, un autre décrivait un comportement que
> Discord n'a pas, le schéma indicatif rendait la table de contenu inatteignable
> par le registre d'effacement, et l'exclusion en dur des salons de logs
> contredisait le principe posé au même paragraphe. Les quatre points ouverts
> sont fermés.

---

## 1. Portée

Ce module capte les événements Discord, les enregistre en base et les restitue
dans des salons dédiés. Il fournit aussi une commande de consultation par membre.

Il ne couvre pas la journalisation technique du bot et du VPS, traitée en phase 6,
ni la logique de sanction, traitée en phase 3 — mais les événements de modération
qu'il enregistre alimenteront le casier.

---

## 2. Événements journalisés

Chaque événement est **activable et désactivable individuellement** dans
`config.yml`, et pointe **individuellement** vers un salon. La répartition en
catégories ci-dessous n'est qu'une valeur par défaut.

### Messages

| Événement | Détail |
|-----------|--------|
| Suppression | contenu, auteur, salon, auteur de la suppression si identifiable |
| Modification | contenu avant et après |
| Suppression en masse | nombre, salon, contenus |

### Vocal

| Événement |
|-----------|
| Connexion à un salon vocal |
| Déconnexion |
| Changement de salon |
| Micro coupé par le serveur |
| Casque coupé par le serveur |
| Mise en attente |

### Membres

| Événement | Clé |
|-----------|-----|
| Arrivée sur le serveur | `member_join` |
| Départ | `member_leave` |
| Changement de pseudo | `member_nickname` |

**Le changement d'avatar est écarté.** Il ne dit rien d'utile à la modération, et
un membre qui change d'image trois fois dans l'après-midi noie le salon.

**L'exclusion temporaire ne figure qu'une fois**, sous Modération, et sous une
seule clé — `member_timeout`, qu'elle soit posée ou levée. Elle était listée ici
et là : c'était un doublon, pas deux événements.

### Rôles

| Événement |
|-----------|
| Attribution d'un rôle à un membre |
| Retrait d'un rôle à un membre |
| Création d'un rôle |
| Suppression d'un rôle |
| Modification d'un rôle (nom, couleur, permissions) |

### Serveur

| Événement |
|-----------|
| Création, suppression, modification d'un salon |
| Modification des permissions d'un salon |
| Modification des webhooks d'un salon |
| Ajout, suppression, renommage d'un émoji |
| Création ou suppression d'une invitation |
| Modification des paramètres du serveur |

**Un seul événement de webhook**, `webhook_update`. La spec en décrivait deux,
une création et une suppression : Discord n'en émet aucun des deux. Il signale
que les webhooks d'un salon ont changé, sans dire lequel ni dans quel sens.

### Modération

| Événement |
|-----------|
| Bannissement |
| Levée de bannissement |
| Expulsion |
| Exclusion temporaire |
| Déclenchement d'une règle AutoMod |

---

## 3. Restitution dans Discord

### Contenu affiché

Pour chaque événement : type, auteur de l'action, cible, salon concerné,
horodatage. Pour les messages : contenu, ou contenus avant et après en cas de
modification.

### Messages longs

Les embeds Discord sont plafonnés. Valeurs à confirmer sur la documentation
officielle au moment de l'implémentation, mais l'ordre de grandeur est connu :
4096 caractères pour la description, 1024 par valeur de champ, 6000 caractères
cumulés sur l'ensemble des embeds d'un même message, 25 champs, 10 embeds.

**Décision : au-delà du seuil, le contenu part en fichier joint**, pas en
troncature. L'embed porte le contexte, le fichier porte le contenu intégral. Le
seuil de bascule est configurable.

### Pièces jointes

Les fichiers d'un message supprimé ne sont **plus accessibles** : leur URL pointe
vers une ressource effacée. Le bot journalise le nom, la taille et le nombre de
fichiers, sans pouvoir les restituer.

Le téléchargement préventif de toutes les pièces jointes est **écarté**
volontairement : il reviendrait à stocker les fichiers des membres sur le VPS,
avec le coût de stockage et l'exposition juridique que cela implique.

### Identification de l'auteur d'une action

Le journal d'audit Discord ne fournit **aucun lien direct** entre une entrée et un
message précis. L'identification passe par une corrélation sur trois critères :
salon, cible, fenêtre temporelle.

Conséquences à assumer :

- Fiable dans le cas courant, faux lorsque deux actions similaires surviennent
  dans la même seconde.
- Discord n'inscrit **rien** au journal d'audit quand un membre supprime son
  propre message.

**L'affichage doit refléter cette incertitude.** Formulation attendue :
« supprimé par X (probable) » lorsque la corrélation a trouvé un tiers,
« auteur inconnu » sinon. Jamais d'affirmation catégorique.

---

## 4. Exclusions

### Principe

**L'exclusion porte sur l'auteur de l'action, jamais sur le message concerné.**

Cette distinction est le cœur du mécanisme :

| Situation | Comportement |
|-----------|--------------|
| Le bot écrit un log | non journalisé |
| Un modérateur supprime un message du bot | **journalisé** |
| Un membre écrit dans un salon exclu | non journalisé |
| Un modérateur supprime un message dans un salon exclu | **journalisé** |

Un filtrage sur le seul auteur du message rendrait invisibles les actions des
modérateurs sur les messages du bot. Il faut donc consulter le journal d'audit
avant de décider d'ignorer un événement.

**Règle de résolution :** si le journal d'audit désigne un tiers, on journalise.
Si le journal d'audit ne dit rien et que l'auteur du message est un compte exclu,
on ignore.

### Listes configurables

| Liste | Contenu |
|-------|---------|
| `exclusions.channels` | salons dont l'activité ordinaire n'est pas journalisée |
| `exclusions.users` | comptes, bots compris |
| `exclusions.roles` | rôles |

### Protection contre la boucle

Sans protection, chaque log déclencherait un log.

Elle repose sur **la présence du bot dans `exclusions.users`**, et sur rien
d'autre : le bot est l'auteur de ses propres écritures, il tombe donc sous le
principe ci-dessus sans qu'aucun traitement particulier soit nécessaire.

> Correction du 18 août 2026. Une version antérieure excluait **en dur les salons
> de journalisation eux-mêmes**. C'était une contradiction avec le principe posé
> au même paragraphe : l'exclusion porte sur l'auteur de l'action, jamais sur
> l'endroit. Cette exclusion aurait rendu invisible la suppression d'un log par
> un modérateur — c'est-à-dire précisément l'événement qu'on voudrait voir.
>
> Conséquence : `exclusions.users` **doit** contenir l'identifiant du bot. C'est
> une entrée de configuration comme une autre, et son absence se voit — les
> salons de logs se mettent à se journaliser les uns les autres.

---

## 5. Groupement des envois

Discord limite le débit d'envoi de messages. Une purge de cent messages ou une
arrivée massive en vocal saturerait un envoi par événement.

- **Fenêtre d'accumulation configurable** via `logs.grouping.window_seconds`,
  2 à 5 secondes par défaut.
- Les événements accumulés partent en un message unique.
- **Le groupement s'applique à tous les salons**, pas seulement aux plus bruyants.
- Un événement isolé part donc avec un léger délai. C'est accepté.

L'écriture en base est **immédiate**, indépendamment du groupement d'affichage.
Un incident au moment de l'envoi Discord ne doit jamais faire perdre la donnée.

---

## 6. Enregistrement en base

Tous les événements sont enregistrés, y compris le contenu des messages supprimés
ou modifiés.

Justification : permet la recherche a posteriori, la reconstitution après une
coupure du bot, et alimente le casier de la phase 3.

---

## 7. Commande de consultation

### Portée

Recherche **par membre uniquement**. Pas de recherche par salon ni par période en
v1.

### Ce qui est renvoyé

**Les métadonnées seulement : type d'événement, salon, horodatage.**
**Jamais le contenu des messages.**

> Choix délibéré. Le contenu reste consultable dans le salon de logs, où il est
> noyé dans le flux chronologique. Une commande de recherche ciblée permettrait au
> contraire de reconstituer d'un coup l'activité complète d'une personne. La
> restriction limite cette possibilité sans nuire à l'usage courant de la
> modération.

### Permissions

Toute la hiérarchie de modération, de `Modo-T` à `Owner`. Configurable via
`commands.history.allowed_roles`.

La spec citait un rôle `Trainee` qui n'existe pas sur le serveur. La hiérarchie
réelle, telle que `config.yml` la porte déjà pour `/unblock` : `Owner`, `Admin`,
`S-Modo`, `Modo`, `Modo-T`. La liste reste propre à cette commande — consulter
l'activité d'un membre et recharger la configuration n'ont aucune raison de
partager la même.

---

## 8. Rattrapage après coupure

Discord ne rejoue pas les événements manqués pendant qu'un bot est hors ligne. Un
rattrapage partiel est possible via le journal d'audit.

### Fonctionnement

1. Au démarrage, lecture de la date du dernier événement enregistré en base.
2. Parcours du journal d'audit depuis cette date.
3. Enregistrement et restitution des événements manquants.

### Plafond

**24 heures par défaut, configurable.** Un bot arrêté trois semaines ne doit pas
déverser trois semaines d'historique au redémarrage.

### Marquage

Les événements rattrapés sont **explicitement signalés comme tels** dans les
salons Discord. Sans cette mention, des événements datés de la veille
apparaîtraient sans explication.

### Limites

Le journal d'audit ne contient ni les messages supprimés, ni leur contenu, ni les
mouvements vocaux. Le rattrapage couvre les bannissements, expulsions,
modifications de rôles et changements structurels. **Le trou sur les messages est
irrécupérable.**

Discord conserve son journal d'audit 90 jours. Au-delà, plus rien n'est
récupérable.

---

## 9. Rétention

| Donnée | Durée par défaut | Clé |
|--------|------------------|-----|
| Contenu des messages supprimés ou modifiés | 30 jours | `logs.retention.message_content_days` |
| Événements structurels | 90 jours | `logs.retention.structural_days` |
| Événements de modération dans `log_events` | 90 jours | `logs.retention.structural_days` |

> Précision levant un renvoi circulaire avec la phase 3. Un bannissement produit
> **deux lignes distinctes** : une dans `log_events` (le fait journalisé), une
> dans `sanctions` (la mémoire de modération). La première suit la rétention des
> événements structurels. La seconde est conservée sans limite et exclue du
> registre de purge. Il n'existe pas de clé `sanctions.retention.*`.

Toutes les valeurs sont configurables. Le module déclare ses tables au registre de
purge du socle.

---

## 10. Tables

| Table | Contenu |
|-------|---------|
| `log_events` | type, auteur, **certitude de l'attribution**, cible, salon, horodatage, **provenance**, entrée d'audit, données structurées |
| `log_message_content` | référence à l'événement, **auteur du message**, **horodatage**, contenu avant, contenu après, métadonnées des pièces jointes |

La séparation du contenu dans une table distincte permet de purger les contenus à
30 jours tout en conservant les métadonnées à 90 jours.

Trois colonnes que le schéma indicatif du 11 août n'avait pas, et sans lesquelles
il ne tenait pas :

- **`log_message_content.author_id`.** Sans elle, la table était **inatteignable
  par le registre d'effacement**, qui cible une colonne portant un identifiant de
  membre. Le contenu des messages — la donnée la plus personnelle que le bot
  conserve — aurait survécu à une demande d'effacement.
- **`log_message_content.created_at`, qui duplique `log_events.occurred_at`.** Ce
  n'est pas une redondance à corriger : le registre de purge exige une colonne de
  date **sur la table qu'il purge**, et les deux tables ont des rétentions
  différentes. Sans elle, le contenu ne pourrait partir qu'avec les métadonnées,
  donc à 90 jours au lieu de 30 — ce qui viderait la séparation de son sens.
- **`log_events.actor_confidence` et `log_events.source`.** La première porte le
  `certain | probable | unknown` du §3 jusqu'à l'affichage ; la seconde le
  `live | catchup` du §8. Toutes deux sont **stockées et non recalculées** : la
  fenêtre de corrélation est configurable, et la relire à l'affichage changerait
  rétroactivement la certitude de lignes déjà écrites.

Les horodatages sont en **ISO 8601 strict, en TEXT, avec le `T`** — jamais
`datetime('now')`. Voir `.claude/rules/database.md` : le registre de purge refuse
la table si la forme dévie.

---

## 11. Intents requis

| Intent | Statut | Usage |
|--------|--------|-------|
| `Guilds` | standard | structure du serveur |
| `GuildMembers` | **privilégié** | arrivées, départs, rôles |
| `GuildMessages` | standard | événements de message |
| `MessageContent` | **privilégié** | contenu des messages |
| `GuildVoiceStates` | standard | journalisation vocale |
| `GuildModeration` | standard | bannissements |
| `GuildExpressions` | standard | émojis et autocollants |
| `GuildWebhooks` | standard | webhooks |
| `GuildInvites` | standard | invitations |
| `AutoModerationExecution` | standard | déclenchements AutoMod |

**Les trois avant-derniers manquaient à la table du 11 août.** Sans eux, les
émojis, les webhooks et les invitations ne remontent **jamais en direct** : ils
ne seraient rattrapés qu'au redémarrage suivant, par le journal d'audit, ce qui
n'est pas de la journalisation. L'omission était silencieuse — Discord n'émet
simplement rien, sans erreur ni avertissement.

`GuildExpressions` est le nom courant du membre de `GatewayIntentBits` ;
`GuildEmojisAndStickers` en est l'alias hérité, présent dans la même version de
discord.js et valant le même bit. On écrit le nom courant.

Les deux intents privilégiés s'activent dans le portail développeur. Aucune
procédure de revue n'est requise en dessous de 10 000 utilisateurs.

**Permission Discord requise :** `View Audit Log`, sans laquelle l'identification
des auteurs et le rattrapage sont impossibles.

---

## 12. Points tranchés

Les quatre points ouverts du 11 août sont fermés. Les trois premiers sont des
réglages purement techniques : ils portent un défaut dans le schéma, seule
catégorie de clés à laquelle le socle §15 l'autorise.

| Point | Décision | Clé |
|-------|----------|-----|
| Seuil de bascule vers le fichier joint | 1024 caractères | `logs.attachment_threshold` |
| Fenêtre de groupement | 5 secondes | `logs.grouping.window_seconds` |
| Tolérance de corrélation avec le journal d'audit | 5 secondes | `logs.audit.correlation_window_seconds` |
| Salons de journalisation | **cinq**, pas neuf | `logs.channels.*` |

**Cinq salons et non neuf** : `messages`, `voice`, `members`, `server`,
`moderation`. Le nombre de neuf venait d'un comptage des catégories du §2, qui
n'est pas la même chose — la répartition des événements en catégories n'est
qu'une valeur par défaut, et chaque événement pointe individuellement vers son
salon. Les identifiants sont renseignés dans `config.yml`.

La fenêtre de groupement reste **propre à ce module**, indépendante de celle de
la phase 6 : les deux flux n'ont ni le même débit ni la même urgence.

Deux réglages sont volontairement **sans défaut** : les deux durées de rétention
du §9. Un défaut silencieux sur une rétention, c'est une donnée personnelle
conservée plus longtemps que prévu sans que personne ne le sache.
