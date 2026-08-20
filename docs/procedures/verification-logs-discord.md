# Vérification de la journalisation Discord sur le serveur

Procédure de mise en service du module `logs`, à exécuter **après déploiement**,
sur le serveur Cubex lui-même.

Elle est réutilisable : chaque famille d'événements suit les mêmes étapes, et le
lot suivant — messages, vocal, serveur — se vérifie de la même façon en
remplaçant la liste des gestes à produire.

---

## Pourquoi cette procédure existe

Jusqu'au lot 4, tout était injecté et vérifiable en mémoire. À partir du moment
où le module écoute la passerelle, `npm test` ne prouve plus grand-chose : il
prouve que le code fait ce qu'on croit d'une charge utile qu'on a écrite
soi-même. La question qui reste — **les écouteurs reçoivent-ils réellement ce
qu'on croit ?** — ne se tranche qu'en marche.

D'où le principe : **tous les événements sont livrés à `enabled: false`**, et
l'activation se fait famille par famille, à la main, après vérification. Le
premier démarrage a lieu sur le serveur réel, lu par le staff : un écouteur qui
se déclenche autrement que prévu y inonderait des salons vivants avant qu'on ait
pu le constater.

Un événement désactivé n'est **ni affiché, ni écrit en base**. La bascule ferme
les deux à la fois : rien n'est collecté tant que rien n'est activé.

---

## Avant de commencer

| Élément | Vérification |
|---------|--------------|
| Compte de test | un compte Discord secondaire, membre du serveur, sans rôle de staff |
| Permission du bot | **View Audit Log**, sans laquelle aucun auteur ne sera identifié |
| Intents privilégiés | `GuildMembers` et `MessageContent` cochés dans le portail développeur |
| Salons de logs | les cinq identifiants de `logs.channels` pointent vers des salons existants |
| Exclusions | le compte de test n'est ni dans `logs.exclusions.users`, ni porteur d'un rôle de `logs.exclusions.roles` |

Le compte de test ne doit **pas** être exclu : l'exclusion porte sur l'auteur de
l'action, et un compte de test exclu ferait paraître le module muet alors qu'il
fonctionne.

### Activer une famille

1. Éditer `config/config.yml`, passer à `true` les seules bascules de la famille.
2. `/reload` dans Discord — l'aiguillage relit la configuration à chaque
   événement, aucun redémarrage n'est nécessaire.
3. Si `/reload` refuse, il affiche la liste des anomalies et **l'ancienne
   configuration reste active**. Corriger et recommencer.

### En cas de défaut

Repasser la famille à `false`, `/reload`, et noter ce qui a été observé. Un
défaut constaté ne se corrige pas en direct sur le serveur : la famille reste
éteinte jusqu'au correctif.

---

## Étape 1 — Tout désactivé : le module se monte

**Prérequis :** toutes les bascules de `logs.events` à `false`.

**Geste :** `sudo systemctl restart cubex-bot`, puis lire le journal du jour :

```bash
tail -f logs/cubex-$(date +%F).log
```

**Le fichier, et non `journalctl`.** En production `NODE_ENV=production` coupe la
sortie console et le journal n'écrit qu'en fichier JSON : `journalctl -u
cubex-bot` ne montre que les blocages de démarrage — secrets manquants,
configuration invalide, connexion refusée — qui partent sur la sortie d'erreur.
Il reste donc à consulter en premier si le bot ne démarre pas du tout.

**À observer**

| Entrée de journal | Attendu |
|-------------------|---------|
| `journalisation Discord montée` | présente, une seule fois, avec `discord_attached: false` |
| `journalisation Discord branchée` | présente, une seule fois, après la connexion, avec l'identifiant du bot |
| `écouteurs Discord attachés` | la liste contient les six écouteurs `logs → …` |
| `bot prêt` | `capabilities_disabled` ne cite **aucune** capacité `logs.channel.*` |

**Ce qui signale un défaut**

- **Une capacité `logs.channel.<famille>` désactivée** : l'identifiant
  correspondant de `logs.channels` est faux ou le salon a été supprimé. **Rien
  d'autre ne sert d'être testé** — les événements seront écrits en base mais
  n'apparaîtront nulle part. Corriger l'identifiant avant de poursuivre.
- **`journalisation Discord branchée` absente** : `ready()` a échoué. Le message
  d'erreur du noyau précède ; la cause la plus probable est un `bot.guild_id`
  faux. Le module reste en mode dégradé — il écrira sans corréler et sans
  envoyer.
- **Le démarrage s'arrête sur une action d'audit inconnue** : la version de
  discord.js a divergé de `AUDIT_ACTIONS`. Le message nomme les actions
  fautives. C'est un refus volontaire, pas une régression à contourner.
- **Un salon reçoit quoi que ce soit** : une bascule est restée à `true`.

---

## Étape 2 — Famille membres

**Prérequis :** étape 1 concluante. Activer `member_join`, `member_leave`,
`member_nickname`, `member_role_add`, `member_role_remove`.

**Gestes**, dans cet ordre, avec le compte de test :

1. rejoindre le serveur ;
2. changer son pseudo de serveur ;
3. recevoir un rôle, attribué par un modérateur ;
4. perdre ce rôle ;
5. quitter le serveur de son plein gré.

**À observer**, dans le salon `logs.channels.members` :

| Geste | Attendu |
|-------|---------|
| Arrivée | « Arrivée sur le serveur », membre nommé, ligne « Compte créé le … » |
| Pseudo | « Changement de pseudo », ancien et nouveau pseudo |
| Rôle attribué | « Rôle attribué », **un seul** événement, le rôle mentionné |
| Rôle retiré | « Rôle retiré », un seul événement |
| Départ | « Départ du serveur », dans ce salon et **pas** dans celui de modération |

Vérifier aussi :

- **L'heure**, en tête de chaque embed, est celle de `bot.timezone` — heure de
  Paris, pas UTC. Un décalage d'une ou deux heures signale un fuseau mal lu.
- **Les dates** des lignes de détail — création du compte, ancienneté — sont
  affichées par Discord et suivent le fuseau du lecteur. Elles peuvent donc
  différer de l'heure en tête : c'est normal.
- **Aucun doublon.** Un pseudo changé en même temps qu'un rôle attribué doit
  produire **deux** événements distincts, pas deux fois le même.

**Ce qui signale un défaut**

- **Un flot d'événements « Rôle attribué » à l'arrivée du compte** : l'état
  d'avant est reconstitué au lieu d'être lu, et tous les rôles passent pour des
  attributions. Éteindre la famille immédiatement.
- **Un changement d'avatar journalisé** : il est écarté par la spec. Sa présence
  signale un écouteur ajouté par erreur.
- **« auteur inconnu » sur l'attribution d'un rôle** : la permission *View Audit
  Log* manque, ou la fenêtre `logs.audit.correlation_window_seconds` est trop
  étroite. L'événement est correct, l'attribution ne l'est pas.
- **Rien n'apparaît, mais les lignes sont en base** : la capacité du salon est
  tombée — revoir l'étape 1.

---

## Étape 3 — Famille modération

**Prérequis :** étape 2 concluante. Activer `member_ban`, `member_unban`,
`member_kick`, `member_timeout`, `automod_action`.

**Gestes**, avec le compte de test, chacun exécuté par un modérateur **identifié**
(pas par le bot) :

1. poser une exclusion temporaire ;
2. lever cette exclusion avant son échéance ;
3. bannir le compte ;
4. lever le bannissement.

**À observer**, dans le salon `logs.channels.moderation` :

| Geste | Attendu |
|-------|---------|
| Exclusion posée | « Exclusion temporaire », ligne « Exclusion jusqu'au … » |
| Exclusion levée | « Exclusion temporaire », ligne « Exclusion levée » — **texte différent du précédent** |
| Bannissement | « Bannissement », membre nommé |
| Levée | « Levée de bannissement » |

**Refaire un bannissement en saisissant une raison** dans la boîte de dialogue de
Discord. La ligne « Raison : … » doit apparaître dans l'embed. Elle ne vient pas
de la passerelle — qui ne la porte pas — mais du journal d'audit : sa présence
prouve que la corrélation a bien trouvé l'entrée, son absence est le même
symptôme qu'un « auteur inconnu ».

Une raison n'apparaît **que** lorsqu'un modérateur en a saisi une. Son absence
sur un bannissement fait sans raison est normale, et aucune ligne vide ne doit
la remplacer.

**Le point central de cette étape : l'attribution de l'auteur.**

Chaque embed porte une ligne « Action de : … ». Trois formulations sont
possibles, et **la nuance n'est pas cosmétique** :

| Affichage | Signification |
|-----------|---------------|
| `@Modérateur` | la plateforme désigne l'auteur elle-même |
| `@Modérateur (probable)` | déduit par corrélation avec le journal d'audit |
| `auteur inconnu` | rien ne désigne d'auteur |

Sur une sanction, la mention **« (probable) » doit être présente** : Discord ne
fournit aucun lien direct entre une sanction et son entrée d'audit, et
l'affichage doit porter cette réserve. **Un nom affirmé sans réserve sur un
bannissement est un défaut**, pas une amélioration : il signifie que le code a
transformé une déduction en certitude.

**Ce qui signale un défaut**

- **« auteur inconnu » systématique** : permission *View Audit Log* absente, ou
  `logs.audit.write_delay_ms` trop court — l'entrée d'audit paraît après
  l'événement de passerelle, et interroger trop tôt ne rend rien.
- **Un auteur affirmé sans réserve** : voir ci-dessus.
- **Le mauvais modérateur nommé** alors que deux ont agi dans la même seconde :
  la fenêtre de corrélation est trop large. La réduire.
- **Une exclusion posée et une exclusion levée affichant le même texte** : la
  variante n'est pas transmise, les deux gestes deviennent indiscernables.
- **Une raison saisie qui n'apparaît pas**, alors que le modérateur est nommé :
  l'entrée d'audit a été trouvée mais sa raison n'est pas reprise. Signaler — la
  raison n'existe nulle part ailleurs, le journal d'audit l'efface à quatre-vingt-dix
  jours, et le casier de la phase 3 en aura besoin.
- **Une raison qui apparaît sur le mauvais événement** : deux sanctions sont
  tombées dans la même seconde et la corrélation a lié la mauvaise entrée. La
  fenêtre est trop large.

---

## Étape 4 — Départ ordinaire contre expulsion

C'est la vérification la plus importante des deux familles, parce que les deux
cas sont **le même signal de passerelle** : Discord annonce qu'un membre n'est
plus là, sans dire s'il est parti ou s'il a été expulsé. Seule une entrée d'audit
récente les sépare, et l'aiguillage en dépend.

**Gestes**, avec le compte de test :

1. rejoindre le serveur, puis le quitter de son plein gré ;
2. rejoindre de nouveau, puis se faire **expulser** par un modérateur.

**À observer**

| Cas | Type affiché | Salon |
|-----|--------------|-------|
| Départ volontaire | « Départ du serveur » | `members` |
| Expulsion | « Expulsion » | `moderation` |

L'expulsion doit en outre nommer le modérateur, avec la réserve « (probable) ».

**Ce qui signale un défaut**

- **Une expulsion affichée en « Départ du serveur », dans le salon des
  membres** : la promotion de type n'a pas eu lieu. Cause la plus probable :
  aucune entrée d'audit trouvée dans la fenêtre — permission manquante, ou
  `logs.audit.write_delay_ms` trop court.
- **Un départ volontaire affiché en « Expulsion »** : **le défaut le plus
  grave de la liste.** L'événement part dans le salon de modération et
  alimentera le casier de la phase 3 — une sanction inscrite au dossier de
  quelqu'un qui est simplement parti. Éteindre `member_leave` et `member_kick`
  immédiatement et signaler.
- **Les deux événements pour un seul départ** : le signal est traité deux fois.

---

## Une fois les quatre étapes concluantes

Laisser les deux familles activées et **relire les salons le lendemain**, à
froid : le volume réel d'un serveur vivant révèle ce qu'un test ne montre pas —
un salon trop bavard, un regroupement mal dimensionné, une exclusion oubliée.

Deux réglages se corrigent sans redémarrage, par `/reload` :

| Symptôme | Réglage |
|----------|---------|
| Le salon défile trop vite | `logs.grouping.window_seconds`, à augmenter |
| Trop d'embeds séparés pour un même geste | `logs.grouping.compact_threshold`, à baisser |

Les familles messages, vocal et serveur restent désactivées jusqu'au lot suivant.
