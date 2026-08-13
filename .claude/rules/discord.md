---
paths:
  - "src/modules/**/*.js"
  - "src/core/commands/**/*.js"
  - "src/core/embeds/**/*.js"
  - "src/utils/template.js"
---

# Modules Discord

## Forme d'un module

Chaque dossier de `src/modules/` exporte : `name`, `commands`, `events`,
`migrations`, `retention`, `init(ctx)`. Le noyau découvre les modules
automatiquement — ne jamais ajouter de liste de modules à maintenir à la main.

## Persistance des composants

**Piège récurrent.** Les boutons et menus déroulants doivent rester fonctionnels
après un redémarrage du bot. Cela impose un **identifiant de composant fixe** et
un routage par cet identifiant.

Ne jamais utiliser un collecteur temporaire attaché à une instance de message : il
cesse de répondre dès que le processus redémarre, et le composant devient muet
sans erreur visible.

Concerne : le bouton de vérification, le menu de tickets, la pagination du casier,
les boutons de prévisualisation d'embed.

## Messages permanents

Un message permanent (vérification, panneau de tickets) voit son identifiant
**stocké en base**. Au démarrage, vérifier sa présence :

| Situation | Action |
|-----------|--------|
| Identifiant en base, message présent | rien |
| Identifiant en base, message absent | republier, enregistrer le nouvel identifiant |
| Aucun identifiant en base | publier, enregistrer |

Sans ce mécanisme, chaque redémarrage crée un doublon.

## Limites de plateforme

| Contrainte | Valeur |
|------------|--------|
| Champs d'une modale | 5 maximum |
| Image dans une modale | impossible |
| Description d'un embed | 4096 caractères |
| Titre d'un embed | 256 caractères |
| Valeur d'un champ d'embed | 1024 caractères |
| Total cumulé des embeds d'un message | 6000 caractères |
| Champs par embed | 25 |
| Embeds par message | 10 |
| Salons par serveur | 500, catégories comprises |
| Salons par catégorie | 50 |

Un bot ne peut éditer que ses propres messages.

Vérifier ces valeurs sur la documentation officielle au moment de
l'implémentation : elles sont stables mais pas gravées.

## Embeds

Tout message du bot passe par un gabarit de `embeds.yml`. Aucun texte ni couleur
écrit dans le code.

| Type | Couleur |
|------|---------|
| Marque | `#F60321` |
| Succès | `#57F287` |
| Erreur | `#E67E22` |
| Information | `#5865F2` |

L'erreur est en orange délibérément : le rouge Discord standard (`#ED4245`) est
trop proche du rouge de marque. Ne pas le « corriger ».

**Les clés `brand`, `success`, `error`, `info` sont une interface publique** : le
module d'embeds les expose au staff, qui les saisit dans une modale. Ce sont les
clés exactes attendues dans `embeds.yml`, en anglais.

Pied de page commun : `Cubex` et un horodatage.

## Variables de gabarit

Accolade simple, noms en **anglais** : `{username}`, `{number}`, `{reason}`.
Motif reconnu : `{[a-z][a-z0-9_]*}`. Tout le reste traverse intact — `{UPPER}`,
`{ username }`, `{123}`, `{"a": 1}` ne sont ni substitués ni signalés.

Le moteur vit dans `src/utils/template.js` et non dans le module de
configuration : il est **partagé** entre `embeds.yml`, `messages.yml` et
certaines valeurs de `config.yml` — le gabarit de nommage des salons de ticket,
`ticket-{number}-{username}`, en est l'exemple.

### Une seule passe, jamais récursive

Une valeur substituée n'est jamais re-rendue. Sans cela, un pseudo Discord
choisi exprès — contenant `{token}` — ferait apparaître une autre variable du
contexte. Ne pas « améliorer » ce point.

### Variable manquante

Le marqueur reste visible dans le texte, et le contrat retourne `{ text,
missing }` à l'appelant, qui journalise. Un `{username}` resté à l'écran se
remarque ; une phrase amputée passe inaperçue. Le socle §9 interdit l'affichage
vide silencieux.

Pas d'import du logger dans le moteur.

### Pas de séquence d'échappement

Il n'existe aujourd'hui aucun moyen d'écrire `{username}` littéralement. Aucun
texte du bot n'en a besoin.

**Condition de déclenchement, si le besoin apparaît :** un texte destiné à
expliquer la syntaxe au staff — les textes d'aide de la modale d'embeds en
phase 5 sont le candidat probable. L'ajout d'un `{{` d'échappement reste
rétro-compatible tant qu'aucun texte existant ne contient `{{`, ce qui se
vérifie par une recherche avant de le poser.

## Commandes

- Slash uniquement. Pas de commandes à préfixe.
- Enregistrement au niveau du serveur, pas globalement.
- Permissions par liste de rôles en configuration. Une liste vide est **refusée**
  à la validation ; ouvrir une commande à tous impose le littéral `"public"`.
- Refus : message éphémère au demandeur seul, aucune trace dans les salons de
  logs.

## Journalisation Discord

L'exclusion porte sur **l'auteur de l'action**, jamais sur le message concerné. Si
le journal d'audit désigne un tiers, journaliser ; s'il ne dit rien et que
l'auteur du message est un compte exclu, ignorer.

Le journal d'audit ne fournit aucun lien direct entre une entrée et un message
précis : la corrélation se fait sur le salon, la cible et une fenêtre temporelle.
Elle est faillible. L'affichage doit dire « supprimé par X (probable) » ou
« auteur inconnu », jamais affirmer.

L'écriture en base est immédiate, indépendamment du groupement d'affichage.

## Couche Minecraft

Le pont est reporté hors v1. `src/minecraft/` contient une interface et une
implémentation inerte qui signale l'indisponibilité de chaque méthode. Toute
commande qui en dépend répond que la fonctionnalité n'est pas active. Ne pas
implémenter le pont sans instruction explicite.
