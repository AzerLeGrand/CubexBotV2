# Module vérification — Phase 1

Contrôle d'accès à l'entrée du serveur Discord. Un nouveau membre n'accède au reste
du serveur qu'après avoir résolu un captcha.

**Statut :** figé le 11 août 2026.
**Prérequis :** socle (`00-socle.md`) opérationnel.

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
    type: image        # image | web
```

---

## 2. Parcours nominal

1. Le membre rejoint le serveur. Il n'a accès qu'au salon de vérification, les
   permissions Discord fermant le reste.
2. Le salon contient un message permanent du bot avec un bouton **Se vérifier**.
3. Le membre clique. Le bot génère une image contenant un code et la lui renvoie
   en **message éphémère**, accompagnée d'un bouton **Entrer le code**.
4. Le membre clique sur ce second bouton. Une **fenêtre modale** s'ouvre avec un
   champ de saisie.
5. Il saisit le code et valide.
6. Si le code est correct : le rôle `Member` est attribué, une confirmation
   éphémère s'affiche, l'événement est journalisé.

**Contrainte de plateforme.** Une modale Discord ne peut pas contenir d'image.
D'où les deux étapes : l'image dans le message éphémère, la saisie dans la modale
ouverte depuis ce message. Ce n'est pas un choix de conception.

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

### Suppression en cours de fonctionnement

Le bot écoute les suppressions de messages dans le salon de vérification et
republie immédiatement si le message d'accueil disparaît.

Cela requiert l'intent `GuildMessages`, **avancé à la phase 1** par rapport à la
planification initiale du socle. Intent non privilégié, aucun coût.

### Persistance des boutons

Les boutons doivent rester fonctionnels après un redémarrage du bot. Cela impose
un **identifiant de composant fixe** et un routage par cet identifiant, et non un
collecteur temporaire attaché à l'instance de message. Le collecteur est l'erreur
classique qui rend un bouton muet après une coupure.

Le contenu du message d'accueil et le libellé des boutons viennent de
`messages.yml` et `embeds.yml`.

---

## 4. Le captcha

### Génération du code

| Paramètre | Valeur par défaut | Clé |
|-----------|-------------------|-----|
| Longueur | 6 caractères | `verification.challenge.code_length` |
| Validité | 5 minutes | `verification.challenge.ttl_seconds` |
| Délai entre deux générations | 5 minutes | `verification.challenge.regen_cooldown_seconds` |

**Alphabet.** Caractères ambigus exclus : ni `0` ni `O`, ni `1`, `I` ou `l`.
L'alphabet est configurable. Sans cette exclusion, des membres échouent en ayant
lu correctement.

### Distinction entre saisie et régénération

Ces deux notions sont indépendantes et ne doivent pas être confondues :

- **Saisir** un code : le membre peut ressaisir plusieurs fois tant que le code
  courant est valide. Chaque saisie erronée consomme une tentative.
- **Régénérer** une image : soumis au délai de 5 minutes, pour éviter qu'on fasse
  tourner la génération en boucle.

**Exception nécessaire :** l'expiration d'un code libère immédiatement le droit
d'en générer un nouveau, sans attendre la fin du délai. Sinon un membre dont le
code a expiré resterait bloqué sans recours.

### Stockage

Le code vit **en mémoire**, associé à l'identifiant du membre, avec son horodatage
d'expiration. Aucune écriture en base. Un redémarrage invalide les codes en cours,
ce qui est acceptable : le membre en génère un nouveau.

### Expiration

Une saisie après expiration répond que le code a expiré et propose d'en générer un
nouveau. Cette saisie **ne consomme pas de tentative**.

### Génération de l'image

Une bibliothèque graphique est nécessaire. Privilégier une solution fournissant des
binaires précompilés : une compilation à l'installation est lourde sur une machine
à 1,8 Go. Arbitrage à l'implémentation.

Paramètres de rendu (déformation, bruit, couleurs, police) configurables.

---

## 5. Tentatives et blocage

### Compteur

| Paramètre | Valeur par défaut | Clé |
|-----------|-------------------|-----|
| Tentatives avant blocage | à définir | `verification.max_attempts` |

Le compteur est **persistant en base**, indexé sur l'identifiant Discord du
membre. Il survit à un redémarrage du bot.

### Blocage

Le blocage est **persistant par identifiant Discord**. Quitter le serveur et le
rejoindre ne le lève pas.

> Ce point remplace une décision antérieure de remise à zéro au retour. Les deux
> ensemble videraient le mécanisme : quitter et rejoindre un serveur prend cinq
> secondes, un script automatisé le ferait en boucle.

Un membre bloqué qui clique sur **Se vérifier** reçoit un message éphémère lui
indiquant que sa vérification est bloquée et qu'il doit contacter le staff.

### Alerte au staff

À l'**épuisement des tentatives uniquement** — jamais à chaque échec individuel,
sinon un membre maladroit déclencherait plusieurs mentions à lui seul.

Le bot mentionne le rôle configuré dans le salon configuré, avec l'identifiant du
membre concerné.

| Paramètre | Valeur | Clé |
|-----------|--------|-----|
| Rôle mentionné | `Bug / Tech Support` | `verification.alert.role_id` |
| Salon d'alerte | à définir | `verification.alert.channel_id` |

> Remarque de conception : `Bug / Tech Support` mêle du support technique et du
> signalement de sécurité, puisque l'alerte se déclenchera aussi bien pour un
> membre en difficulté que pour un bot. Le paramètre étant configurable, ce choix
> peut évoluer à l'usage.

### Déblocage

Commande slash de déblocage, prenant un membre en paramètre. Elle remet le
compteur à zéro et lève le blocage.

**Rôles autorisés :** toute la hiérarchie de modération, de `Trainee` à `Owner`.
Configurable via `commands.unblock.allowed_roles`.

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
| Vérification réussie | salon **membres** |
| Échec de saisie | base uniquement |
| Épuisement des tentatives | mention du rôle configuré dans le salon d'alerte |

Conserver les échecs en base sans notification permet de repérer a posteriori une
vague anormale de tentatives.

### Rétention

| Donnée | Durée par défaut | Clé |
|--------|------------------|-----|
| Historique des tentatives et vérifications | 90 jours | `verification.retention.history_days` |
| Blocages actifs | **jamais purgés** | — |

Les blocages actifs sont exclus de la purge : un blocage supprimé automatiquement
se lèverait tout seul, ce qui viderait le mécanisme de son sens. Seul l'historique
est soumis à rétention.

Le module déclare ses tables au registre de purge du socle.

---

## 8. Tables

Schéma indicatif, à préciser à l'implémentation.

| Table | Contenu |
|-------|---------|
| `verification_state` | identifiant du membre, nombre de tentatives, statut de blocage, date de blocage |
| `verification_history` | identifiant du membre, type d'événement, horodatage |
| `verification_message` | identifiant du salon, identifiant du message d'accueil |

---

## 9. Prérequis côté Discord

À effectuer manuellement, hors code :

1. Le rôle du bot doit être positionné **au-dessus de `Member`** dans la
   hiérarchie, sinon l'attribution échouera.
2. Les permissions des salons doivent être fermées à `@everyone` et ouvertes à
   `Member`, seul le salon de vérification restant accessible aux non-vérifiés.
3. L'intent `GuildMembers` doit être activé dans le portail développeur.

---

## 10. Points ouverts

1. **Nombre de tentatives avant blocage** — valeur par défaut à fixer.
2. **Bibliothèque de génération d'images** — arbitrage à l'implémentation.
3. **Identifiants réels** du salon de vérification, du salon d'alerte et du rôle
   `Member`.
4. **Paramètres de rendu** de l'image — à affiner visuellement une fois la
   bibliothèque choisie.
