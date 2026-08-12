# Module tickets — Phase 4

Système de support. Un membre ouvre un ticket depuis un menu, répond à un
questionnaire, et obtient un salon privé avec l'équipe concernée.

**Statut :** figé le 11 août 2026.
**Prérequis :** socle (`00-socle.md`).

---

## 1. Portée

Ouverture, routage, gestion et archivage des tickets de support. Six catégories
correspondant aux six rôles de support du serveur.

Ce module n'implémente aucune logique de sanction ni de journalisation générale :
il déclare ses événements au module de journalisation de la phase 2, qui les
restitue dans le salon **tickets**.

---

## 2. Ouverture

### Le message permanent

Un salon de support contient un message permanent du bot portant un **menu
déroulant** listant les six catégories. Chaque entrée porte un libellé et une
description, tous deux définis dans `messages.yml`.

Le menu est préféré aux boutons : il tient dans un seul message, supporte des
descriptions par entrée, et reste lisible avec six choix.

**Persistance.** Comme pour les modules de vérification et de sanctions, le menu
doit utiliser un **identifiant de composant fixe**. Un collecteur temporaire
cesserait de répondre après un redémarrage du bot.

**Publication.** Même mécanisme que le message de vérification : identifiant
stocké en base, vérification de présence au démarrage, republication si absent.

### Le questionnaire

La sélection d'une catégorie ouvre une **fenêtre modale** contenant les questions
propres à cette catégorie.

**Les questions diffèrent par catégorie.** Un ticket boutique n'appelle pas les
mêmes informations qu'une candidature au recrutement. Elles sont définies dans la
configuration, par catégorie.

**Contrainte de plateforme : une modale Discord accepte au maximum cinq champs de
saisie.** Le questionnaire de chaque catégorie est donc plafonné à cinq questions.
La validation de la configuration doit refuser le démarrage si une catégorie en
déclare davantage, avec un message explicite.

Chaque question déclare son libellé, son caractère obligatoire ou facultatif, son
style (ligne unique ou paragraphe) et sa longueur maximale.

### Le récapitulatif

À la création du salon, le bot y publie en premier message un embed reprenant
**les questions et les réponses telles que saisies**, plus le membre demandeur, la
catégorie et l'horodatage.

> Précision : il s'agit d'un récapitulatif, pas d'une reformulation. Le bot
> n'effectue aucune synthèse du contenu — cela supposerait un appel à un modèle de
> langage, avec la dépendance externe, le coût et la latence que cela implique.
> Hors périmètre v1.

Cet embed est épinglé dans le salon.

---

## 3. Le salon de ticket

### Forme

Un **salon textuel**, pas un fil. Les fils s'archivent automatiquement et sont
moins lisibles pour un membre peu habitué à Discord.

### Emplacement

**Une catégorie Discord par type de support.** Six catégories permanentes, dont
les identifiants sont en configuration.

**Contrainte de plateforme à surveiller :** Discord plafonne un serveur à 500
salons, catégories comprises, et une catégorie à 50 salons. Les salons étant
supprimés à la fermeture, la marge est confortable pour l'échelle visée. Le bot
doit néanmoins traiter proprement l'échec de création plutôt que de planter.

### Nommage

Gabarit configurable, par exemple `ticket-{numero}-{pseudo}`. Le numéro est
incrémental et stocké en base.

### Permissions

À la création, le salon est visible de :

- le membre demandeur ;
- le rôle de support correspondant à la catégorie ;
- le rôle `Staff`.

Tous les autres rôles en sont exclus, `@everyone` compris.

> Le rôle `Staff` a accès à toutes les catégories, `Appeal Support` compris. C'est
> un choix assumé : un modérateur peut donc lire une contestation le concernant.
> Les listes étant configurables, ce point peut évoluer à l'usage.

---

## 4. Routage

Chaque catégorie déclare les rôles à mentionner à l'ouverture.

```yaml
tickets:
  categories:
    - id: "game"
      name_key: "tickets.categories.game.name"
      category_id: "1234567890123456789"
      ping_role_ids:
        - "1234567890123456789"
      questions: [...]
```

**Rappel du socle, appliqué ici en priorité.** C'est cette structure qui a mis
l'ancien bot à l'arrêt :

```
tickets.categories.0.ping_role_ids.0: Expected string, received number
```

Tout identifiant est une chaîne. La validation rejette explicitement les nombres,
indique le chemin complet de la clé fautive et rappelle qu'il faut des guillemets.

Le rôle est **mentionné** dans le salon à l'ouverture, pas seulement ajouté
silencieusement.

---

## 5. Gestion d'un ticket ouvert

| Action | Qui | Détail |
|--------|-----|--------|
| Ajouter un membre | staff | commande prenant un membre en paramètre |
| Retirer un membre | staff | idem |
| Fermer | membre demandeur ou staff | motif obligatoire |

**Pas de notion de prise en charge ni d'assignation.** Pas de fermeture
automatique après inactivité.

### Motif de fermeture

**Obligatoire, sans exception.** Une fermeture sans motif est refusée, y compris
lorsqu'elle est demandée par le membre lui-même. Le motif est enregistré et
apparaît dans la transcription et dans le salon **tickets**.

---

## 6. Fermeture et transcription

### Format

Fichier **HTML** autonome, lisible dans un navigateur, contenant l'intégralité des
messages du salon : auteur, horodatage, contenu, et métadonnées des pièces jointes
(nom, taille — les fichiers eux-mêmes ne sont pas rapatriés).

### Destinations

1. Salon **tickets** défini en phase 2.
2. Message privé au membre demandeur.

### Ordre des opérations

Cet ordre est impératif :

1. Générer la transcription.
2. L'envoyer dans le salon tickets.
3. **Vérifier la réussite de cet envoi.**
4. Envoyer la copie au membre en message privé.
5. Supprimer le salon.

**Si l'envoi au salon tickets échoue, le salon n'est pas supprimé** et une erreur
est journalisée. Supprimer avant d'avoir confirmé l'archivage rendrait la
conversation irrécupérable.

**Si le message privé échoue** — le membre peut avoir désactivé les messages
privés des membres du serveur — l'échec est journalisé et la fermeture se poursuit
normalement. Ce n'est pas bloquant.

### Suppression

Le salon est supprimé, pas déplacé vers une catégorie d'archives. La transcription
constitue l'archive.

---

## 7. Limites et protection contre l'abus

| Paramètre | Valeur par défaut | Clé |
|-----------|-------------------|-----|
| Tickets ouverts simultanément par membre | 2 | `tickets.max_open_per_user` |
| Délai entre deux ouvertures | quelques minutes, à fixer | `tickets.open_cooldown_seconds` |

Un membre atteignant l'une des deux limites reçoit un message éphémère le lui
indiquant, sans création de salon.

### Exclusion

Une liste de membres privés du droit d'ouvrir un ticket, gérée par commande et
persistée en base. Sans elle, un membre abusif ne peut être arrêté qu'en lui
retirant l'accès au salon de support à la main.

**Rôles autorisés à exclure et réintégrer :** toute la hiérarchie de modération,
configurable.

---

## 8. Journalisation

| Événement | Enregistré en base | Envoyé dans le salon tickets |
|-----------|--------------------|-----------------------------|
| Ouverture | oui | oui |
| Ajout ou retrait d'un membre | oui | non |
| Fermeture | oui | oui, avec le motif et la transcription |

---

## 9. Tables

Schéma indicatif, à préciser à l'implémentation.

| Table | Contenu |
|-------|---------|
| `tickets` | numéro, identifiant du salon, membre, catégorie, statut, date d'ouverture, date de fermeture, motif de fermeture, auteur de la fermeture |
| `ticket_answers` | référence au ticket, question, réponse |
| `ticket_blacklist` | identifiant du membre, auteur de l'exclusion, motif, horodatage |
| `ticket_panel` | identifiant du salon, identifiant du message du menu |

### Rétention

| Donnée | Durée par défaut |
|--------|------------------|
| Tickets et réponses | à fixer |
| Exclusions actives | jamais purgées |

Même logique que pour les blocages de vérification : une exclusion supprimée
automatiquement se lèverait toute seule.

---

## 10. Permissions Discord requises

| Permission | Usage |
|------------|-------|
| `Manage Channels` | création et suppression des salons de ticket |
| `Manage Roles` | définition des permissions par salon |
| `Read Message History` | génération de la transcription |
| `Attach Files` | envoi du fichier HTML |

---

## 11. Points ouverts

1. **Contenu exact des questionnaires** pour chacune des six catégories — cinq
   questions maximum par catégorie.
2. **Délai entre deux ouvertures** — valeur par défaut à fixer.
3. **Rétention des tickets fermés** en base.
4. **Gabarit de nommage** des salons.
5. **Identifiants réels** des six catégories Discord, du salon de support et des
   six rôles de support.
