# Module journalisation Discord — Phase 2

Enregistrement et restitution des événements du serveur Discord. Le module le plus
volumineux de la v1.

**Statut :** figé le 11 août 2026.
**Prérequis :** socle (`00-socle.md`) opérationnel.

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

| Événement |
|-----------|
| Arrivée sur le serveur |
| Départ |
| Changement de pseudo |
| Changement d'avatar |
| Exclusion temporaire appliquée ou levée |

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
| Création ou suppression d'un webhook |
| Ajout, suppression, renommage d'un émoji |
| Création ou suppression d'une invitation |
| Modification des paramètres du serveur |

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

### Exclusion non désactivable

Les salons de journalisation eux-mêmes sont exclus **en dur** des écritures du
bot, sans possibilité de le désactiver. C'est la protection contre la boucle :
sans elle, chaque log déclencherait un log.

---

## 5. Groupement des envois

Discord limite le débit d'envoi de messages. Une purge de cent messages ou une
arrivée massive en vocal saturerait un envoi par événement.

- **Fenêtre d'accumulation configurable**, 2 à 5 secondes par défaut.
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

Toute la hiérarchie de modération, de `Trainee` à `Owner`. Configurable via
`commands.history.allowed_roles`.

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
| Événements de modération | voir phase 3 | — |

Toutes les valeurs sont configurables. Le module déclare ses tables au registre de
purge du socle.

---

## 10. Tables

Schéma indicatif, à préciser à l'implémentation.

| Table | Contenu |
|-------|---------|
| `log_events` | type, auteur, cible, salon, horodatage, données structurées |
| `log_message_content` | référence à l'événement, contenu avant, contenu après, métadonnées des pièces jointes |

La séparation du contenu dans une table distincte permet de purger les contenus à
30 jours tout en conservant les métadonnées à 90 jours.

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
| `AutoModerationExecution` | standard | déclenchements AutoMod |

Les deux intents privilégiés s'activent dans le portail développeur. Aucune
procédure de revue n'est requise en dessous de 10 000 utilisateurs.

**Permission Discord requise :** `View Audit Log`, sans laquelle l'identification
des auteurs et le rattrapage sont impossibles.

---

## 12. Points ouverts

1. **Seuil de bascule** vers le fichier joint — valeur par défaut à fixer.
2. **Fenêtre de groupement** — 2 ou 5 secondes.
3. **Tolérance de corrélation** avec le journal d'audit — fenêtre temporelle
   acceptable pour attribuer une action à un auteur.
4. **Identifiants réels** des neuf salons de journalisation.
