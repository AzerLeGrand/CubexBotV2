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

## Exception à la règle « aucun texte codé en dur »

**Portée strictement limitée au module de configuration.** Les messages d'erreur
de chargement et de validation sont écrits en dur dans le code, parce qu'ils
s'affichent précisément quand `messages.yml` peut être inchargeable :
l'indirection créerait une dépendance circulaire.

| Texte | Origine |
|-------|---------|
| Erreur de chargement ou de validation (console, administrateur) | codée en dur |
| Corps technique d'une erreur : chemin de la clé, contrainte, instruction | codé en dur |
| Enveloppe du message de `/reload` renvoyé dans Discord | `messages.yml` |
| Tout autre texte, partout ailleurs | `messages.yml` |

Au rechargement à chaud, l'ancienne configuration est toujours en mémoire :
`messages.yml` est donc disponible et doit être utilisé pour l'enveloppe. Seul le
diagnostic reste en dur.

Ne pas étendre cette exception à un autre module.

### Constante d'identité

Critère : un texte reste en clair dans `embeds.yml` s'il est une constante
d'identité — nom de marque, mention légale invariante — et non un message
adressé à quelqu'un. `footer.text: "Cubex"` en relève : il ne varie ni selon
le destinataire, ni selon la situation, ni selon la langue. Un texte qui
répond à une action, décrit un état ou s'adresse à un membre va dans
`messages.yml`, sans exception.

## Portabilité : jamais de primitive dépendante de l'environnement

Toute valeur venue d'un fichier versionné — `config.yml`, `messages.yml`,
`embeds.yml`, une migration SQL, un export de module — est lue par le poste
Windows **et** par le VPS Debian. Elle doit être validée, comparée et triée
de façon identique des deux côtés.

**N'utilisez jamais une primitive dont le comportement dépend de la plateforme
ou de la locale d'exécution** pour juger une telle valeur.

| À proscrire | Pourquoi | À la place |
|-------------|----------|------------|
| `path.isAbsolute()` | `C:\data` est absolu sous Windows, relatif sous Linux | `isAbsolutePath()` de `utils/paths.js`, qui couvre les deux conventions |
| `String.localeCompare()` | dépend de l'ICU chargée | comparaison binaire `a < b ? -1 : 1` |
| Contenu de fichier brut haché | Git livre le même fichier en CRLF ou en LF | normaliser les fins de ligne avant l'empreinte |
| `toLocaleString()`, `toLocaleDateString()` | dépend de la locale du processus | `Intl` avec locale et fuseau explicites |
| `getHours()`, `getDate()`, `getMonth()` | lisent des composantes civiles selon le fuseau système | `bot.timezone`, toujours |
| Chemin d'import dont la casse diffère du fichier | Windows est insensible à la casse, Linux non | respecter la casse exacte, y compris dans les chemins construits |
| `\` comme séparateur dans une valeur configurée | sous Linux, `data\bot.db` est un nom de fichier, pas un chemin | `/`, que Node accepte des deux côtés |

Le symptôme est toujours le même : le code passe sur une machine et échoue sur
l'autre, ou pire, passe sur les deux en produisant des résultats différents.

Trois occurrences relevées avant que la règle ne soit écrite : `localeCompare`
sur l'ordre des propriétaires de migrations, l'empreinte des migrations sensible
au CRLF, et `path.isAbsolute()` sur les chemins de `config.yml`. La troisième
n'a été vue qu'en exécutant les tests sur le VPS.

**Corollaire pour les tests :** un test qui valide une valeur portable doit
couvrir les deux formes, pas seulement celle de la machine qui l'écrit.

**Corollaire pour le déploiement :** `npm test` s'exécute sur la machine cible
avant le premier démarrage. C'est le seul endroit où une divergence de plateforme
se prouve.

## Détecteur de secrets : motifs en dur

Deuxième exception assumée, distincte de la précédente. Les motifs de
`secrets.js` ne sont **pas** configurables.

Rendre un détecteur réglable depuis le fichier même qu'il surveille permettrait
de le désactiver depuis l'endroit qu'il protège. Une configuration compromise
pourrait vider la liste des motifs, et le démarrage réussirait.

Corollaire : la valeur détectée n'est jamais citée dans le message d'erreur. Le
message nomme la clé fautive et la nature du soupçon, rien d'autre — ces
journaux partiront vers Discord en phase 6.

## Convention *_key

Aucun texte destiné à un utilisateur ne figure dans `config.yml`. Un champ qui
désignerait un texte porte le suffixe `_key` et pointe vers `messages.yml` :
`name_key`, `description_key`, `label_key`.

La validation croisée vérifie au démarrage que chaque `*_key` résout vers une clé
existante. Une clé morte est une erreur de validation, pas une modale vide
découverte par un membre.

## Tests

Les tests vivent dans `tests/`, jamais dans `test/` : le runner de Node traite
tout fichier situé sous un dossier nommé `test/` comme un fichier de test, ce qui
fait exécuter à vide les helpers et les fixtures. Le filtrage se fait sur
`*.test.js`.

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
