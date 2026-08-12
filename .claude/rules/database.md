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
- Une table interne enregistre les migrations appliquées : numéro, nom,
  horodatage.
- Application automatique au démarrage, dans l'ordre, en transaction.
- Une migration en échec arrête le démarrage.
- **Ne jamais modifier une migration déjà appliquée.** En ajouter une nouvelle.

Chaque module déclare ses propres fichiers de migration via son export
`migrations`.

## Registre de purge

Aucun module n'écrit sa propre logique de suppression. Chaque module déclare :

```js
retention: [
  { table: 'log_events', date_column: 'created_at', retention_key: 'logs.retention.structural_days' }
]
```

Une tâche quotidienne à 4h00 (Europe/Paris) parcourt le registre et supprime.
Une erreur sur une table n'interrompt pas le traitement des autres. Le compte
rendu indique le nombre de lignes supprimées par table.

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
