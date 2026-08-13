# Migrations du noyau

Fichiers SQL numérotés, appliqués automatiquement au démarrage, dans l'ordre et
en transaction.

```
001_description.sql
```

Trois chiffres au moins, puis un nom en minuscules, chiffres et tirets bas. Un
fichier `.sql` qui ne suit pas ce motif fait échouer le démarrage : l'ignorer
signifierait qu'une migration ne s'applique jamais sans que rien ne le signale.

## Règle absolue

**Une migration appliquée n'est jamais modifiée.** On en ajoute une nouvelle.

Le contenu de chaque fichier est empreint au moment de l'application et
l'empreinte est vérifiée à chaque démarrage. Retoucher un fichier déjà appliqué,
le supprimer, le renuméroter ou glisser un numéro sous un numéro déjà dépassé
arrête le bot avec un message qui nomme le fichier.

Les fins de ligne sont normalisées avant l'empreinte : le même fichier livré en
CRLF sur un poste Windows et en LF sur le VPS donne la même valeur.

## Migrations des modules

Chaque module de `src/modules/` déclare son propre dossier par son export
`migrations`. Sa numérotation lui est propre : `tickets/001` et `core/001`
coexistent sans se gêner, la table de suivi les distingue par leur propriétaire.

L'ordre d'application est déterministe — le noyau d'abord, ses tables pouvant
être référencées, puis les modules par ordre alphabétique.

## Table de suivi

`schema_migrations` est créée par le code, pas par une migration : elle doit
exister avant que la première ne s'applique.

| Colonne | Rôle |
|---------|------|
| `owner` | `core` ou nom du module |
| `number` | numéro du fichier |
| `name` | description tirée du nom de fichier |
| `checksum` | empreinte SHA-256 du contenu normalisé |
| `applied_at` | horodatage ISO 8601 |

Ce dossier est vide en phase 0 : le noyau n'a pas de table propre.
