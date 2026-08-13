---
paths:
  - "src/modules/**/*.js"
  - "src/core/commands/**/*.js"
  - "src/core/embeds/**/*.js"
  - "src/utils/template.js"
---

# Modules Discord

## Forme d'un module

Chaque dossier de `src/modules/` exporte : `name`, `commands`, `components`,
`events`, `migrations`, `retention`, `erasure`, `capabilities`, `init(ctx)`,
`ready(ctx)`. Le noyau découvre les modules automatiquement — ne jamais ajouter
de liste de modules à maintenir à la main.

Il peut poser à côté un `manifest.js` facultatif : `schema`, le fragment de
`config.yml` qui lui appartient, et `intents`. Lu avant la configuration, il ne
fait rien d'autre que déclarer.

### Écouteurs et cycle de vie

```js
export const events = [
  { name: 'messageDelete', execute: async (ctx, message) => { ... } },
];
```

`name` est la valeur camelCase de `Events`, jamais la clé PascalCase :
`MessageDelete` poserait un écouteur que Discord n'appelle jamais. Le contexte
vient **en premier**, à l'inverse des commandes — les arguments d'un événement
sont variadiques, aucun paramètre fixe ne peut suivre un rest.

Ne jamais déclarer `clientReady` : il est réservé au noyau, dont la séquence
enchaîne l'enregistrement des commandes puis la vérification des références. Ce
qui doit tourner au démarrage une fois l'API disponible va dans `ready(ctx)`,
appelé après cette vérification — donc quand le module sait si sa capacité est
active. `ready` ne s'exécute **qu'au démarrage** : pour réagir à un
rechargement, s'abonner à `config.on('reload')`.

Un écouteur ne relance jamais : le noyau l'enveloppe, journalise et poursuit.
Un module désactivé (§5.5 du socle) ne reçoit ni événement ni `ready`.

## Persistance des composants

**Piège récurrent.** Les boutons et menus déroulants doivent rester fonctionnels
après un redémarrage du bot. Cela impose un **identifiant de composant fixe** et
un routage par cet identifiant.

Ne jamais utiliser un collecteur temporaire attaché à une instance de message : il
cesse de répondre dès que le processus redémarre, et le composant devient muet
sans erreur visible.

Concerne : le bouton de vérification, le menu de tickets, la pagination du casier,
les boutons de prévisualisation d'embed.

### Format de l'identifiant

```
module:action:arg1:arg2
```

Construit par `encodeCustomId()` de `src/core/components/index.js`, **jamais à la
main**. Le nom du module en tête est l'espace de nommage : deux modules déclarent
`confirm` sans se marcher dessus. Les arguments décodés arrivent en dernier
paramètre d'`execute`.

Les arguments sont des **chaînes**, sans conversion implicite : accepter un
nombre reviendrait à accepter qu'un identifiant Discord arrive déjà tronqué.
Écrire `String(page)` et assumer la conversion.

Discord plafonne l'identifiant à **100 caractères**. Dépassement et séparateur
dans un segment sont **refusés à la construction, jamais tronqués** : un
identifiant coupé ne route nulle part, ou pire, route vers autre chose.

**L'identifiant transporte une clé, jamais un contenu.** Deux conséquences qu'on
découvre autrement en pleine phase 5 :

- **Le plafond se consomme vite.** Un identifiant Discord fait 19 chiffres.
  `verification:code:` suivi de deux identifiants, et il ne reste presque rien.
  La contrainte ne concerne pas que les gros contenus.
- **Ce qui va en mémoire ne survit pas à un redémarrage.** Acceptable pour une
  prévisualisation d'embed en cours de composition, inacceptable pour un message
  permanent, dont l'état va en base. Le critère est la **durée de vie attendue du
  composant**, pas la taille du contenu.

### Permission d'un composant

Une déclaration porte **soit** `permission: 'public'`, **soit**
`permission_key: 'commands.embed.allowed_roles'`, un chemin vers `config.yml` —
jamais une liste de rôles écrite dans le code. Ni l'un ni l'autre, ou les deux :
refus bloquant au démarrage.

Aucun défaut, dans un sens comme dans l'autre. Ouvrir par défaut reproduirait la
liste vide qui ouvrirait `/ban` à tous ; fermer par défaut rendrait muet le
bouton de vérification, destiné à des membres qui n'ont aucun rôle.

Une clé qui ne résout pas refuse à tous, et le démarrage la signale — même
contrôle que pour une commande sans entrée dans `config.yml`.

### Accusé de réception : deux contraintes opposées

Elles décident de la forme du code et se découvrent douloureusement.

| Situation | Règle |
|-----------|-------|
| Ouvrir une modale | `showModal()` **doit être la première réponse** à l'interaction — impossible d'accuser réception puis d'ouvrir |
| Traitement de plus de 3 secondes | accusé préalable obligatoire (`deferReply` ou `deferUpdate`), qui porte la fenêtre à 15 minutes |

Les deux boutons de la phase 1 tombent chacun d'un côté : « Entrer le code »
ouvre directement une modale, « Se vérifier » rend une image de façon synchrone
donc défère puis édite.

**Le routeur du noyau n'accuse jamais réception à la place du module** : un
`deferReply()` posé là rendrait `showModal()` impossible partout. C'est au module
de savoir lequel des deux cas s'applique.

### Ce que le routeur ne fait pas

Aucun contrôle de propriété du message. Discord garantit déjà qu'un composant
porté par un message **éphémère** n'est cliquable que par son destinataire. Un
composant public qui doit se restreindre inscrit l'identifiant du membre dans son
identifiant de composant — non falsifiable, puisqu'il provient d'un message que le
bot a lui-même posté. Ne pas ajouter cette couche.

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

### Dépassement : tronquer ou refuser, selon qui écrit

Deux traitements opposés, à ne pas confondre.

| Contexte | Traitement |
|----------|------------|
| Moteur d'embeds, messages automatiques du bot | **tronquer en signalant** — un embed rejeté par l'API est un message qui n'arrive jamais |
| Prévisualisation de `/embed create`, contenu saisi par le staff | **refuser sans publier** — le staff peut corriger, une troncature silencieuse défigurerait une annonce officielle |

La troncature du moteur est un filet de sécurité de dernier recours, pas le
comportement attendu en phase 5.

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
