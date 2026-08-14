# Module vérification — Phase 1

Contrôle d'accès à l'entrée du serveur Discord. Un nouveau membre n'accède au reste
du serveur qu'après avoir résolu un captcha.

**Statut :** révisée le 14 août 2026, avant toute implémentation.
**Prérequis :** socle (`00-socle.md`) et socle 0.2 opérationnels.

---

## 1. Portée et intention

Le but est d'arrêter les bots de spam qui rejoignent en masse pour diffuser des
invitations. Ce n'est pas un dispositif de sécurité contre un attaquant motivé.

**Limite assumée.** Un code déformé sur une image est lisible par n'importe quel
outil de reconnaissance de caractères actuel. Turnstile ou hCaptcha analysent en
plus des signaux de navigateur, le comportement de la souris et la réputation de
l'adresse IP — ce qu'un captcha rendu dans Discord ne peut pas reproduire. Le
choix de l'image est délibéré : il évite de rouvrir un service HTTP sur le VPS
(nginx, certificat TLS, ports 80 et 443), et il évite de transmettre des données
de membres à un tiers.

**Limite d'accessibilité.** Une image de texte exclut les personnes malvoyantes,
sans alternative audio. Le déblocage par le staff constitue le recours.

L'épreuve est conçue comme interchangeable : le module expose une interface avec
une implémentation `image` (livrée) et une implémentation `web` (prévue, non
écrite). Le basculement se fait par configuration, sans réécriture du module.

```yaml
verification:
  challenge:
    type: image        # image (web prévu, non écrit)
```

Le schéma du module ne déclare que `image` tant que l'implémentation `web`
n'existe pas : accepter une valeur dont rien ne répond ferait démarrer un bot
qui ne vérifierait personne, sans qu'aucun message ne le signale.

---

## 2. Parcours nominal

1. Le membre rejoint le serveur. Il n'a accès qu'au salon de vérification, les
   permissions Discord fermant le reste.
2. Le salon contient un message permanent du bot avec un bouton **Se vérifier**.
3. Le membre clique. Le bot **accuse réception** de l'interaction, génère une image
   contenant un code, puis **édite** sa réponse éphémère pour y joindre l'image et
   un bouton **Entrer le code**.
4. Le membre clique sur ce second bouton. Une **fenêtre modale** s'ouvre
   immédiatement avec un champ de saisie.
5. Il saisit le code et valide.
6. Si le code est correct : le rôle `Member` est attribué, le compteur de
   tentatives est remis à zéro, une confirmation éphémère s'affiche, l'événement
   est journalisé.

**Contrainte de plateforme (1).** Une modale Discord ne peut pas contenir d'image.
D'où les deux étapes : l'image dans le message éphémère, la saisie dans la modale
ouverte depuis ce message. Ce n'est pas un choix de conception.

**Contrainte de plateforme (2).** Les deux boutons se comportent différemment, et
c'est imposé, pas choisi :

| Bouton | Traitement | Raison |
|--------|-----------|--------|
| Se vérifier | accuse réception, puis édite | le rendu de l'image est synchrone, la fenêtre de réponse initiale est de 3 secondes |
| Entrer le code | ouvre la modale directement | `showModal()` doit être la **première** réponse à une interaction, un accusé préalable l'interdit |

---

## 3. Message d'accueil

### Publication

Le bot vérifie au démarrage la présence du message dans le salon configuré :

| Situation | Comportement |
|-----------|--------------|
| Identifiant en base, message présent | rien |
| Identifiant en base, message absent | republication, nouvel identifiant enregistré |
| Aucun identifiant en base | publication, identifiant enregistré |

L'identifiant du message est **stocké en base**. Sans cela, chaque redémarrage
créerait un doublon et le salon se remplirait.

Cette vérification a lieu dans le crochet `ready(ctx)` du socle 0.2, appelé après
`verifyDiscordRefs()`. Un écouteur `clientReady` déclaré par le module ne
conviendrait pas : il partirait en parallèle de la séquence du noyau et publierait
avant de savoir si la capacité du module est active. Le noyau refuse d'ailleurs
cette déclaration au démarrage.

### Suppression en cours de fonctionnement

Le bot écoute les suppressions de messages dans le salon de vérification et
republie immédiatement si le message d'accueil disparaît.

Cela requiert l'intent `GuildMessages`, **avancé à la phase 1** par rapport à la
planification initiale du socle. Intent non privilégié, aucun coût. Il est déclaré
par le manifeste du module, avec `GuildMembers`.

### Persistance des boutons

Les boutons doivent rester fonctionnels après un redémarrage du bot. Cela impose
un **identifiant de composant fixe** et un routage par cet identifiant, et non un
collecteur temporaire attaché à l'instance de message. Le collecteur est l'erreur
classique qui rend un bouton muet après une coupure.

Les identifiants sont construits par l'encodeur du noyau, au format
`verification:<action>`. Aucune donnée n'y transite : le plafond est de 100
caractères et un identifiant Discord en consomme 19 à lui seul.

Le contenu du message d'accueil et le libellé des boutons viennent de
`messages.yml` et `embeds.yml`.

---

## 4. Le captcha

### Génération du code

| Paramètre | Valeur par défaut | Clé |
|-----------|-------------------|-----|
| Longueur | 6 caractères | `verification.challenge.code_length` |
| Validité | 5 minutes | `verification.challenge.ttl_seconds` |
| Alphabet | 31 caractères | `verification.challenge.alphabet` |

**Alphabet.** Caractères ambigus exclus : ni `0` ni `O`, ni `1`, `I` ou `l`.
L'alphabet est configurable. Sans cette exclusion, des membres échouent en ayant
lu correctement.

### Reclic pendant la validité d'un code

Un membre qui reclique sur **Se vérifier** alors que son code est encore valide
reçoit **le même code et la même image**. Aucun nouveau code n'est généré, aucun
rendu n'est recalculé.

Il n'existe donc **pas de délai entre deux générations**. La durée de validité
plafonne à elle seule le rythme : un membre ne peut déclencher qu'une génération
toutes les cinq minutes.

> Cette décision remplace le `regen_cooldown_seconds` de la version précédente de
> ce document. Réglé en dessous de la validité, il ne pouvait jamais mordre ;
> réglé au-dessus, il aurait imposé une attente forcée à un membre dont le code
> venait d'expirer — exactement ce que l'exception « l'expiration libère
> immédiatement le droit de régénérer » cherchait à éviter. Une seule horloge
> suffit.

### Stockage

Le code vit **en mémoire**, associé à l'identifiant du membre, avec son horodatage
d'expiration **et l'image déjà rendue**. Aucune écriture en base.

Conserver le PNG évite tout recalcul au reclic, ce qui rend inutile un garde-fou
anti-spam sur le bouton. Le coût est de l'ordre de 20 Ko par entrée : deux cents
membres simultanés représentent 4 Mo, ce qui tient sur les 1,8 Go du VPS.

Un balayage périodique retire les entrées expirées. Sans lui, la table en mémoire
ne ferait que croître. Son intervalle est un réglage purement technique et admet
donc une valeur par défaut dans le schéma.

Un redémarrage invalide les codes en cours, ce qui est acceptable : le membre en
génère un nouveau.

### Expiration

Une saisie après expiration répond que le code a expiré et propose d'en générer un
nouveau. Cette saisie **ne consomme pas de tentative**.

### Saisie et comparaison

Le code saisi est normalisé avant comparaison :

| Paramètre | Valeur par défaut | Clé |
|-----------|-------------------|-----|
| Sensible à la casse | non | `verification.challenge.input.case_sensitive` |
| Espaces retirés | oui | `verification.challenge.input.strip_whitespace` |

Un membre qui lit correctement l'image ne doit pas échouer sur une majuscule ou un
espace collé par un correcteur automatique de téléphone.

### Génération de l'image

**`@napi-rs/canvas`.** Binaires précompilés N-API, donc aucune compilation à
l'installation — ce qui compte sur une machine à 1,8 Go — et API Canvas complète,
qui rend la déformation et le bruit accessibles.

Deux conséquences à traiter dans le code :

- **Le rendu est synchrone** et bloque la boucle d'événements. D'où l'accusé de
  réception préalable du bouton **Se vérifier** (§2). Le temps de rendu réel sera
  mesuré à l'implémentation pour décider s'il faut en plus sérialiser les rendus
  lors d'une vague d'arrivées.
- **Aucune police n'est garantie présente** sur une installation Debian minimale.
  Une police est donc versionnée dans le dépôt, sous une licence qui l'autorise
  (OFL), et son chemin est configurable.

Paramètres de rendu — dimensions, police, taille, couleurs, bruit, déformation —
tous configurables sous `verification.challenge.image`.

---

## 5. Tentatives et blocage

### Compteur

| Paramètre | Valeur par défaut | Clé |
|-----------|-------------------|-----|
| Tentatives avant blocage | 5 | `verification.max_attempts` |

Le compteur est **persistant en base**, indexé sur l'identifiant Discord du
membre. Il survit à un redémarrage du bot. Il est **remis à zéro après une
vérification réussie**.

> Cinq n'est pas une valeur de résistance au force brute : six caractères sur un
> alphabet de trente et un font près d'un milliard de combinaisons, le nombre de
> tentatives n'y change rien. Le compteur sert à couper l'automatisation et à
> signaler un membre en difficulté.

### Blocage

Le blocage est **persistant par identifiant Discord**. Quitter le serveur et le
rejoindre ne le lève pas.

> Ce point remplace une décision antérieure de remise à zéro au retour. Les deux
> ensemble videraient le mécanisme : quitter et rejoindre un serveur prend cinq
> secondes, un script automatisé le ferait en boucle.

Un membre bloqué qui clique sur **Se vérifier** reçoit un message éphémère lui
indiquant que sa vérification est bloquée et qu'il doit contacter le staff.

### Alerte à l'épuisement des tentatives

À l'**épuisement des tentatives uniquement** — jamais à chaque échec individuel,
sinon un membre maladroit déclencherait plusieurs mentions à lui seul.

Le bot mentionne le rôle configuré dans le salon d'alerte, avec l'identifiant du
membre concerné.

| Paramètre | Valeur | Clé |
|-----------|--------|-----|
| Rôle mentionné | `Bug / Tech Support` | `verification.alert.exhausted_role_id` |
| Salon d'alerte | salon d'alerte technique | `verification.alert.channel_id` |

> Remarque de conception : `Bug / Tech Support` mêle du support technique et du
> signalement de sécurité, puisque l'alerte se déclenchera aussi bien pour un
> membre en difficulté que pour un bot. Le paramètre étant configurable, ce choix
> peut évoluer à l'usage.

### Alerte sur échec d'attribution du rôle

Distincte de la précédente, et destinée à un autre public.

Si le bot ne parvient pas à attribuer `Member` — rôle du bot placé trop bas dans
la hiérarchie, permission retirée, rôle supprimé — le membre reçoit un message
d'erreur éphémère **et** le staff d'administration est mentionné dans le même
salon d'alerte.

| Paramètre | Valeur | Clé |
|-----------|--------|-----|
| Rôle mentionné | administration | `verification.alert.failure_role_id` |

C'est une panne de configuration du serveur, pas un incident de modération : elle
empêche **toute** entrée sur le serveur et doit remonter à qui peut la corriger.

### Déblocage

Commande slash de déblocage, prenant un membre en paramètre. Elle remet le
compteur à zéro et lève le blocage.

**Rôles autorisés :** toute la hiérarchie de modération, de `Trainee` à `Owner`.
Configurable via `commands.unblock.allowed_roles`, dans la section `commands` du
noyau et non dans la section du module.

Sans cette commande, un membre bloqué le resterait définitivement, le seul recours
étant une modification manuelle de la base.

---

## 6. Membres déjà présents

- **Au démarrage, le bot ne fait rien.** Les membres présents ne reçoivent pas
  `Member` automatiquement et ne sont pas invités à se vérifier.
- Un membre possédant déjà `Member` qui clique sur **Se vérifier** est **ignoré** :
  message éphémère indiquant qu'il est déjà vérifié, sans génération de code ni
  consommation de tentative.

---

## 7. Journalisation

### En base

| Événement | Enregistré |
|-----------|------------|
| Vérification réussie | identifiant du membre, horodatage |
| Échec de saisie | identifiant du membre, horodatage |
| Blocage | identifiant du membre, horodatage |
| Déblocage | membre, auteur de l'action, horodatage |

### Dans Discord

| Événement | Destination |
|-----------|-------------|
| Vérification réussie | salon de journalisation des arrivées — **clé à trancher, voir §12.1** |
| Échec de saisie | base uniquement |
| Épuisement des tentatives | mention du rôle configuré dans le salon d'alerte |
| Échec d'attribution du rôle | mention du rôle d'administration dans le salon d'alerte |

Conserver les échecs en base sans notification permet de repérer a posteriori une
vague anormale de tentatives.

### Rétention

| Donnée | Durée par défaut | Clé |
|--------|------------------|-----|
| Historique des tentatives et vérifications | 90 jours | `verification.retention.history_days` |
| État des membres, blocages compris | **jamais purgé** | — |
| Identifiant du message d'accueil | **jamais purgé** | — |

Les blocages actifs sont exclus de la purge : un blocage supprimé automatiquement
se lèverait tout seul, ce qui viderait le mécanisme de son sens. Seul l'historique
est soumis à rétention.

Le module déclare ses tables au registre de purge du socle.

---

## 8. Tables et effacement

Schéma indicatif, à préciser à l'implémentation.

| Table | Contenu | Purge | Effacement |
|-------|---------|-------|------------|
| `verification_state` | identifiant du membre (clé), tentatives, statut de blocage, date de blocage | jamais | `delete` |
| `verification_history` | identifiant du membre, type d'événement, horodatage | 90 jours | `delete` |
| `verification_message` | identifiant du salon, identifiant du message d'accueil | jamais | — |

### Pourquoi `delete` et non `anonymize`

La stratégie `anonymize` du socle remplace l'identifiant du membre par `'0'`. Elle
est **impossible** sur `verification_state`, dont l'identifiant du membre est la
clé : le deuxième effacement heurterait la ligne déjà anonymisée, et l'effacement
étant atomique, toute la transaction serait annulée — y compris les tables des
autres modules. Le garde-fou du socle 0.2 refuse d'ailleurs cette déclaration au
démarrage.

Restait à choisir entre `delete` et une pseudonymisation par empreinte. Cette
dernière préserverait le blocage tout en masquant l'identifiant, mais la clé de
hachage vivrait dans `.env` et permettrait de revenir à l'identifiant d'origine :
c'est une pseudonymisation, pas une anonymisation, et elle ne répond donc pas à
une demande d'effacement.

**Conséquence assumée : un effacement lève le blocage.** L'argument qui justifie
la persistance du blocage est qu'un script pourrait quitter et rejoindre le
serveur en boucle. Une demande d'effacement, elle, passe par un échange humain
avec le staff : le contournement automatisé n'est pas rouvert. Un membre effacé
qui revient repart d'un compteur à zéro et se refera bloquer aux mêmes tentatives.

`verification_message` ne contient aucune donnée de membre et ne déclare donc rien
au registre d'effacement.

---

## 9. Capacités et références Discord

Le module déclare ses références au socle. Une référence introuvable au démarrage
produit un avertissement et désactive la capacité correspondante ; marquée
critique, elle désactive le module entier.

| Référence | Critique | Effet si introuvable |
|-----------|----------|---------------------|
| `verification.channel_id` | oui | module entier désactivé — sans salon, rien n'est possible |
| `verification.member_role_id` | oui | module entier désactivé — une vérification réussie n'aboutirait à rien |
| `verification.alert.channel_id` | non | les deux alertes se taisent, la vérification continue |
| `verification.alert.exhausted_role_id` | non | l'alerte d'épuisement se tait |
| `verification.alert.failure_role_id` | non | l'alerte technique se tait |
| salon de journalisation (§12.1) | non | la journalisation Discord se tait, la base continue |

Un salon d'alerte supprimé ne doit pas empêcher les membres d'entrer sur le
serveur. C'est la raison d'être de la distinction entre capacité critique et
capacité simple.

---

## 10. Configuration

Section `verification` de `config.yml`, validée par le fragment de schéma du
module. Les valeurs de rendu sont indicatives et seront affinées visuellement.

```yaml
verification:
  channel_id: "1503043771015762143"
  member_role_id: "1381766005604352130"

  challenge:
    type: image        # image (web prévu, non écrit)
    code_length: 6
    ttl_seconds: 300
    alphabet: "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
    input:
      case_sensitive: false
      strip_whitespace: true
    image:
      width: 320
      height: 110
      font_path: "assets/fonts/<à figer à l'implémentation>"
      font_size: 52
      background: "#FFFFFF"
      text_color: "#1A1A1A"
      noise_lines: 6
      noise_dots: 220
      distortion: 0.35

  max_attempts: 5

  alert:
    channel_id: "1537574082890174648"
    exhausted_role_id: "1503034271546343544"
    failure_role_id: "1537574425229004841"

  retention:
    history_days: 90
```

Aucune valeur codée en dur ailleurs. Les libellés, titres et messages vivent dans
`messages.yml` et `embeds.yml`.

---

## 11. Prérequis côté Discord

À effectuer manuellement, hors code :

1. Le rôle du bot doit être positionné **au-dessus de `Member`** dans la
   hiérarchie, sinon l'attribution échouera — c'est précisément le cas que
   l'alerte technique du §5 fait remonter.
2. Les permissions des salons doivent être fermées à `@everyone` et ouvertes à
   `Member`, seul le salon de vérification restant accessible aux non-vérifiés.
3. L'intent `GuildMembers` doit être activé dans le portail développeur. À défaut,
   la connexion est refusée par Discord ; le socle 0.2 nomme l'intent fautif dans
   son diagnostic.
4. Le rôle mentionné par l'alerte technique doit être **effectivement porté** par
   au moins un membre de l'administration. Une mention vers un rôle vide ne
   prévient personne.

---

## 12. Points ouverts

1. **Clé du salon de journalisation des vérifications réussies.** La version
   précédente de ce document envoyait l'événement vers le salon *membres*, défini
   par la phase 2. Deux options :

   - une clé propre au module, `verification.log.channel_id` ;
   - une référence à `logs.channels.members`, qui n'existera qu'en phase 2.

   La première est recommandée : le mécanisme de fragments de schéma du socle 0.2
   ne valide que la section appartenant au module, et une lecture dans une section
   qui n'existe pas encore rendrait la capacité silencieusement inactive jusqu'à
   la phase 2. Le coût est deux clés pointant le même salon une fois la phase 2
   livrée.

2. **Paramètres de rendu de l'image** — à affiner visuellement une fois la police
   choisie et la première image produite.

3. **Police** — fichier et licence à figer à l'implémentation, puis à versionner
   sous `assets/fonts/`.
