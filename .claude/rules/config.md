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

## Références Discord

Après connexion, vérifier chaque identifiant de rôle, salon et catégorie auprès de
l'API. Une référence introuvable produit un avertissement journalisé et désactive
la fonctionnalité concernée — elle n'arrête pas le bot. La fonctionnalité
désactivée répond aux commandes qu'elle est indisponible, sans planter.

## Rechargement à chaud

Commande réservée aux rôles Owner et Admin (liste configurable).

Si la nouvelle configuration est invalide : **conserver l'ancienne en mémoire**,
continuer de tourner, renvoyer la liste des erreurs au demandeur.
