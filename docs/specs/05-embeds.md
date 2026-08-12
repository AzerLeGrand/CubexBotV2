# Module commandes d'embeds — Phase 5

Publication et gestion de messages formatés par le staff. Outil de confort : le
moteur de rendu existe déjà au socle, ce module ne fait que l'exposer en commandes.

**Statut :** figé le 11 août 2026.
**Prérequis :** socle (`00-socle.md`), moteur d'embeds opérationnel.

---

## 1. Portée

Permettre au staff de publier une annonce, un règlement ou une information sous
forme d'embed, puis de la modifier ou de la supprimer plus tard.

**Limite de plateforme, structurante.** Un bot ne peut éditer que ses propres
messages. Tout contenu destiné à être modifié un jour doit donc avoir été publié
par le bot, jamais collé à la main par un membre du staff.

Ce module ne remplace pas `embeds.yml`. Les gabarits du socle servent aux messages
automatiques du bot (confirmations, refus, alertes). Ce module sert aux
publications ponctuelles rédigées par le staff.

---

## 2. Commandes

| Commande | Rôle |
|----------|------|
| `/embed create` | composer et publier un embed |
| `/embed edit` | modifier un embed déjà publié |
| `/embed delete` | supprimer un embed publié |
| `/embed list` | lister les embeds publiés par le bot |

### Permissions

**Owner et Admin uniquement.** Configurable via `commands.embed.allowed_roles`.

Publier un message au nom du serveur engage son image ; l'accès est volontairement
plus restreint que pour les commandes de modération.

---

## 3. Composition

### Déroulement

1. Le staff lance `/embed create` en indiquant le **salon de destination** en
   paramètre de la commande.
2. Une **fenêtre modale** s'ouvre pour la saisie du contenu.
3. Le bot affiche une **prévisualisation éphémère**, visible du seul demandeur.
4. Deux boutons : publier, ou annuler.

Le salon est un paramètre de commande et non un champ de modale, afin de ne pas
consommer l'un des cinq champs disponibles.

### Champs de la modale

**Contrainte de plateforme : une modale Discord accepte cinq champs maximum.**

| Champ | Obligatoire | Détail |
|-------|-------------|--------|
| Titre | non | 256 caractères maximum |
| Description | oui | 4096 caractères maximum |
| Couleur | non | voir ci-dessous |
| URL d'image | non | image affichée sous le contenu |
| Texte de pied de page | non | remplace le pied par défaut si renseigné |

Les libellés et textes d'aide de ces champs viennent de `messages.yml`.

### Couleur

Le champ accepte deux formes :

- un **nom de couleur du socle** : `brand`, `success`, `error`, `info` ;
- une **valeur hexadécimale** : `#F60321`.

Champ laissé vide : la couleur de marque `#F60321` s'applique.

Une valeur invalide est refusée à la prévisualisation, avec un message explicite.
Aucune publication n'a lieu.

### Pied de page

Par défaut, le pied de page commun défini au socle : `Cubex` et un horodatage.
Un texte saisi dans la modale le remplace.

---

## 4. Prévisualisation

**Obligatoire avant toute publication.** L'embed est rendu tel qu'il apparaîtra,
en message éphémère visible du seul demandeur.

Elle porte deux boutons : publier dans le salon indiqué, ou annuler.

La prévisualisation est aussi le moment où les limites Discord sont vérifiées :
4096 caractères pour la description, 256 pour le titre, 6000 cumulés sur
l'ensemble d'un message. Un dépassement est signalé au demandeur sans publication.

---

## 5. Modification et suivi

### Suivi en base

Chaque embed publié est enregistré : identifiant du message, identifiant du salon,
auteur, date, et contenu saisi.

Cela permet à `/embed list` d'afficher les embeds existants et à `/embed edit` de
désigner un embed sans avoir à récupérer son identifiant par clic droit.

### Modification

`/embed edit` prend en paramètre l'identifiant interne de l'embed, obtenu via
`/embed list`. La modale se rouvre **préremplie** avec le contenu actuel. Même
prévisualisation avant validation.

L'enregistrement en base est mis à jour, avec l'auteur et la date de la
modification.

### Suppression

`/embed delete` supprime le message Discord et marque la ligne comme supprimée en
base — sans effacer l'enregistrement, afin de conserver la trace de ce qui a été
publié.

### Message introuvable

Un embed supprimé manuellement dans Discord laisse un enregistrement orphelin. À
la première tentative de modification ou de suppression, le bot constate l'absence,
répond au demandeur et marque la ligne comme supprimée.

---

## 6. Hors périmètre v1

**Aucun composant interactif** — boutons, menus — sur les embeds publiés. Un
bouton exige un identifiant de composant persistant et une logique d'action
associée, ce qui reviendrait à construire un système de rôles-réactions ou de
formulaires. Hors périmètre.

Les liens hypertexte dans la description restent possibles : c'est du Markdown
standard, pris en charge nativement.

---

## 7. Journalisation

| Événement | Destination |
|-----------|-------------|
| Publication | salon **bot** (catégorie admin) |
| Modification | salon **bot** |
| Suppression | salon **bot** |

Chaque entrée mentionne l'auteur de l'action, le salon de destination et
l'identifiant de l'embed. Le contenu n'est pas recopié dans le log : il est
consultable dans le salon de publication.

Le salon **bot** n'étant alimenté qu'à partir de la phase 6, ces événements
partent d'abord dans les journaux en fichier.

---

## 8. Tables

Schéma indicatif, à préciser à l'implémentation.

| Table | Contenu |
|-------|---------|
| `embeds` | identifiant interne, identifiant du message, identifiant du salon, contenu saisi, auteur de la création, date de création, auteur de la dernière modification, date de modification, statut |

Champ `statut` : `published`, `deleted`.

### Rétention

Les enregistrements ne sont **pas purgés**. Le volume est négligeable et
l'historique des publications officielles a une valeur de traçabilité.

Le module ne déclare donc rien au registre de purge.

---

## 9. Permissions Discord requises

| Permission | Usage |
|------------|-------|
| `Send Messages` dans les salons de destination | publication |
| `Embed Links` | rendu des embeds |
| `Manage Messages` | suppression |

Un salon où le bot ne peut pas écrire doit produire un message d'erreur explicite
au demandeur, pas un échec silencieux.

---

## 10. Points ouverts

1. **Syntaxe des variables** dans les gabarits — point commun avec le socle. Les
   embeds composés par le staff en acceptent-ils, ou sont-ils entièrement
   statiques ?
2. **Champs multiples** (les `fields` d'un embed Discord) — absents de la modale
   faute de place. À évaluer si le besoin apparaît.
