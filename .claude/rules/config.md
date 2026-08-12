---
paths:
  - "src/core/config/**/*.js"
  - "config/**/*.yml"
---

# Configuration

## Trois fichiers, séparés par nature

| Fichier | Contenu | Interdit |
|---------|---------|----------|
| `config.yml` | identifiants, seuils, délais, bascules | tout texte destiné à un utilisateur |
| `messages.yml` | textes destinés aux utilisateurs | réglages techniques |
| `embeds.yml` | gabarits d'affichage | logique |
| `.env` | secrets | réglages fonctionnels |

Les trois YAML sont versionnés (dépôt privé). `.env` est exclu de Git,
`.env.example` est versionné avec des valeurs vides.

## Identifiants Discord

Toujours en chaîne. La validation doit :

1. Rejeter un identifiant fourni comme nombre, avec le chemin complet de la clé
   fautive et un rappel qu'il faut des guillemets.
2. Vérifier le format : 17 à 20 chiffres.

```yaml
roles:
  member: "1234567890123456789"   # correct
  admin: 1234567890123456789      # refusé au démarrage
```

L'erreur `tickets.categories.0.ping_role_ids.0: Expected string, received number`
a arrêté la version précédente du bot. Ne pas assouplir cette validation.

## Validation au démarrage

- Porte sur l'intégralité des trois fichiers.
- **Collecter toutes les erreurs et les afficher ensemble**, jamais la première
  seule.
- Une erreur de validation arrête le bot.
- Refuser le démarrage si une clé YAML ressemble à un secret : `token`,
  `password`, `secret`, `api_key`, `apikey`.

## Permissions de commande

`allowed_roles` accepte **soit** une liste non vide d'identifiants, **soit** le
littéral `"public"`. Une liste vide est une erreur de validation.

```yaml
commands:
  ban:
    allowed_roles: ["ID_MOD", "ID_ADMIN"]
  ping:
    allowed_roles: "public"
```

Ne jamais traiter `[]` comme une ouverture à tous : une liste vidée par erreur
d'édition ouvrirait `/ban` à `@everyone` en silence.

## Valeurs par défaut

`.default()` est réservé aux réglages purement techniques. Sont **obligatoires**,
sans défaut : tout identifiant Discord, toute liste `allowed_roles`, toute durée
de rétention. Un défaut silencieux sur une rétention, c'est une donnée
personnelle conservée plus longtemps que prévu sans que personne ne le sache.

## L'objet config est un accesseur, jamais un instantané

```js
// FAUX — fige la valeur, le rechargement à chaud devient sans effet
const { tickets } = ctx.config.get();

// CORRECT — lecture au moment de l'usage
ctx.config.get('tickets.max_open_per_user');
```

## Convention *_key

Aucun texte destiné à un utilisateur ne figure dans `config.yml`. Un champ qui
désignerait un texte porte le suffixe `_key` et pointe vers `messages.yml` :
`name_key`, `description_key`, `label_key`.

La validation croisée vérifie au démarrage que chaque `*_key` résout vers une clé
existante. Une clé morte est une erreur de validation, pas une modale vide
découverte par un membre.

## Détection de secrets — deux passes distinctes

- sur les **noms de clés** : `token`, `password`, `secret`, `api_key`, `apikey` ;
- sur les **valeurs** : formes de secrets réels uniquement (jeton Discord, clé
  d'API), jamais ces mots-clés.

Sans cette séparation, la clé `tech_logs.redaction.patterns` de la phase 6 — qui
contient par construction des motifs reconnaissant ces mots — ferait échouer le
démarrage.

## Pas d'import du logger

Le module de configuration **n'importe jamais** la journalisation : il émet des
événements et reçoit un logger injecté après construction. L'inverse crée un
cycle `config → logging → config`, puisque la validation doit journaliser.

## Références Discord

Après connexion, vérifier chaque identifiant de rôle, salon et catégorie auprès de
l'API. Une référence introuvable produit un avertissement journalisé et désactive
la fonctionnalité concernée — elle n'arrête pas le bot. La fonctionnalité
désactivée répond aux commandes qu'elle est indisponible, sans planter.

**Capacités des collections :** dériver l'identité d'une entrée de sa clé `id`,
jamais de sa position. Un chemin du type `tickets.categories.0.category_id`
casse silencieusement au premier réordonnancement du fichier.

## Rechargement à chaud

Commande réservée aux rôles Owner et Admin (liste configurable).

Si la nouvelle configuration est invalide : **conserver l'ancienne en mémoire**,
continuer de tourner, renvoyer la liste des erreurs au demandeur.
