---
paths:
  - "src/core/database/**/*.js"
  - "src/core/purge/**/*.js"
  - "migrations/**/*.sql"
---

# Base de données

`better-sqlite3`, fichier dans `data/`. Mode journal WAL, clés étrangères
activées.

Ne pas basculer sur `node:sqlite` : il est en *Stability 1.2 — Release candidate*
sur Node 24, pas encore stable. Les deux API sont proches, la bascule restera
possible plus tard.

## Migrations

- Fichiers SQL numérotés dans `migrations/`, nommés `001_description.sql`.
- La table de suivi porte une colonne `owner`, clé primaire `(owner, number)` :
  chaque module a sa propre séquence.
- Application automatique au démarrage, dans l'ordre, en transaction.
- Une migration en échec arrête le démarrage.
- **Ne jamais modifier une migration déjà appliquée.** En ajouter une nouvelle.

Chaque module déclare ses propres fichiers de migration via son export
`migrations`.

### Ordre d'application

`core` en premier par comparaison explicite, puis les autres propriétaires par
ordre de nom, en **comparaison binaire**. Jamais `localeCompare` : son résultat
dépend de l'ICU chargée, l'ordre pourrait différer entre un poste Windows et le
VPS Debian.

L'ordre ne dépend jamais de la découverte du système de fichiers.

### Pas de clé étrangère entre modules

**Une migration de module ne référence que ses propres tables ou celles du
noyau.** Aucune table déclarée dans les specs des phases 1 à 6 n'y contrevient.

Il n'existe volontairement aucune déclaration de dépendance entre modules : leur
ordre d'application est déterministe mais arbitraire, et rien ne garantit qu'il
corresponde à un ordre de dépendance. Si le besoin d'une table partagée
apparaissait, cette table appartiendrait au noyau.

### Propriétaire absent

La distinction porte sur la présence du **propriétaire**, jamais sur celle du
fichier seul.

| Situation | Traitement |
|-----------|------------|
| Source fournie, fichier manquant | erreur bloquante : quelqu'un a supprimé ou renuméroté une migration d'un module actif |
| Aucune source fournie pour ce propriétaire | avertissement journalisé, démarrage normal |

**Les tables ne sont jamais supprimées.** Un module retiré peut l'être
temporairement, et ses données — tickets archivés, transcriptions — n'ont pas à
disparaître parce qu'on a commenté un dossier. Le nettoyage reste une décision
humaine.

« Source fournie » dépend de la **présence du module sur disque**, jamais d'un
état d'activation. Un module dont une référence Discord est introuvable est
désactivé au sens du socle §5.5 mais reste chargé : ses migrations continuent de
s'appliquer.

### Dépendance critique au chargeur de modules

Cette règle transforme « pas de source » en « module absent ». Un module présent
mais qui échoue à s'importer produirait la même absence, et ses migrations
cesseraient de s'appliquer en silence.

**Un module présent dans `src/modules/` qui échoue à s'importer doit arrêter le
démarrage. Jamais être ignoré.** La sûreté du traitement ci-dessus en dépend
entièrement.

## Registre de purge

Aucun module n'écrit sa propre logique de suppression. Chaque module déclare :

```js
retention: [
  { table: 'log_events', date_column: 'created_at', retention_key: 'logs.retention.structural_days' }
]
```

Une tâche quotidienne à 4h00, dans le fuseau `bot.timezone`, parcourt le registre
et supprime. Une erreur sur une table n'interrompt pas le traitement des autres.
Le compte rendu indique le nombre de lignes supprimées par table.

### Format obligatoire de `date_column`

**La colonne doit contenir un horodatage ISO 8601 strict en TEXT**, avec le `T`
séparateur : `2026-08-13T04:00:00.000Z`. Ce n'est pas une préférence de style,
c'est une condition de sûreté, et deux pièges distincts la justifient.

**Le mauvais type.** SQLite ordonne les types avant les valeurs :
`NULL < INTEGER < TEXT`. Une colonne stockée en entier Unix, comparée à un seuil
ISO en TEXT, rend `date_column < cutoff` **toujours vrai** — la purge viderait la
table entière, silencieusement, à 4 h du matin.

**Le mauvais séparateur.** `datetime('now')` produit `2026-08-13 04:00:00`, avec
un espace. C'est bien du TEXT, donc la comparaison ne déraille pas sur les types,
mais l'espace (`0x20`) précède le `T` (`0x54`) : toutes les lignes du jour
passeraient pour antérieures au seuil. Une purge décalée d'une journée, tous les
jours, indétectable à l'œil.

**Règle qui en découle : n'utilisez jamais `datetime('now')`.**

| Besoin | Écriture |
|--------|----------|
| Horodatage écrit par le code | `new Date().toISOString()` — la voie normale |
| Valeur par défaut en SQL, si vraiment nécessaire | `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` |

Le registre **vérifie** au premier passage sur chaque table : lecture d'une
valeur non nulle, contrôle de la forme, refus de purger cette table sinon. Table
vide, rien à vérifier, report au passage suivant. Une erreur sur une table
n'interrompt pas les autres.

La valeur lue n'est **jamais citée** dans le message d'erreur : si `date_column`
désignait la mauvaise colonne, ce serait du contenu de message qui partirait au
journal, puis vers Discord en phase 6. Le message donne le type et le caractère
en position 10, ce qui suffit à distinguer les deux cas.

### Validation des identifiants SQL

Table et colonne sont validées à l'inscription contre `/^[a-z_][a-z0-9_]*$/`.
Elles sont interpolées dans la requête — SQLite ne les accepte pas en paramètre
lié — et viennent du code des modules, mais la porte se ferme au registre plutôt
que de compter sur la discipline des appelants.

## Exclusions de purge

Ces données ne sont jamais purgées automatiquement :

| Donnée | Motif |
|--------|-------|
| Sanctions | mémoire de modération, conservation sans limite |
| Blocages de vérification actifs | un blocage purgé se lèverait tout seul |
| Exclusions de tickets actives | même raison |
| Enregistrements d'embeds publiés | volume négligeable, valeur de traçabilité |

## Droit à l'effacement

L'architecture doit permettre de retrouver et supprimer toutes les données d'un
identifiant Discord donné, à travers l'ensemble des tables. Prévoir cette
recherche transversale dès la conception du schéma.

## Séparation contenu / métadonnées

Le contenu des messages journalisés vit dans une table distincte des métadonnées.
C'est ce qui permet de purger les contenus à 30 jours tout en conservant les
métadonnées à 90 jours.
