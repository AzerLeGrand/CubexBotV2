# Module journalisation technique — Phase 6

Relais vers Discord des journaux applicatifs du bot et des journaux système du
VPS. Deux salons de la catégorie admin : **bot** et **système VPS**.

**Statut :** figé le 11 août 2026, révisé le 12 août 2026.
**Prérequis :** socle (`00-socle.md`), journalisation Discord (`02-logs-discord.md`)
pour le mécanisme de groupement.

---

## 1. Portée

Ce module ne produit aucun journal : le socle le fait déjà, en JSON dans `logs/`.
Il **relaie** vers Discord, en filtrant, masquant, groupant et limitant le débit.

Il couvre deux sources sans rapport entre elles :

| Source | Origine | Salon |
|--------|---------|-------|
| Journaux applicatifs | le bot lui-même | **bot** |
| Journaux système | le VPS (`journalctl`) | **système VPS** |

**Accès :** ces deux salons sont réservés à Owner, Admin et Developer. Un journal
technique peut laisser échapper un chemin de fichier, une adresse IP ou un détail
d'infrastructure.

---

## 2. Journaux applicatifs du bot

### Niveaux relayés

Le seuil est configurable via `tech_logs.bot.min_level`.

| Niveau | Relayé par défaut | Remarque |
|--------|-------------------|----------|
| `error` | oui | |
| `warn` | oui | |
| `info` | oui | démarrages, arrêts, rechargements de configuration |
| `debug` | **non** | volume ingérable, réservé au diagnostic local |

`debug` reste écrit en fichier. L'activer en relais Discord est possible par
configuration mais déconseillé : il produit plusieurs entrées par événement.

### Événements notables

Outre les erreurs, partent dans le salon **bot** :

- démarrage et arrêt du bot, avec la version ;
- rechargement de configuration, avec l'auteur et le résultat ;
- échec de validation de configuration au rechargement, avec la liste des erreurs ;
- référence Discord introuvable au démarrage et fonctionnalité désactivée en
  conséquence (voir socle, section 5.5) ;
- **compte rendu de la purge quotidienne** : nombre de lignes supprimées par
  table. Ce relais ferme le point laissé ouvert au socle, section 10 ;
- événements du module d'embeds : publication, modification, suppression
  (voir `05-embeds.md`).

---

## 3. Journaux système du VPS

### Mécanisme d'accès

Le bot lit le journal systemd en continu. Cela requiert que l'utilisateur
`cubexbot` appartienne au groupe **`systemd-journal`** :

```bash
sudo usermod -aG systemd-journal cubexbot
```

Lecture seule, sans `sudo`, sans droit d'écriture. C'est la voie la moins
invasive : ni script système à maintenir, ni interrogation périodique.

**À vérifier lors de l'implémentation** que l'accès fonctionne effectivement sous
Debian 13 avec cette seule appartenance de groupe.

### Unités surveillées

Liste configurable via `tech_logs.system.units`.

| Unité | Événements retenus |
|-------|--------------------|
| `ssh` | connexions réussies, échecs d'authentification |
| `fail2ban` | bannissements et levées de bannissement |
| `unattended-upgrades` | paquets mis à jour, redémarrage requis |
| `pm2-cubexbot` | démarrages et arrêts du service |

### Sondes périodiques

Indépendantes du journal, exécutées à intervalle configurable.

| Sonde | Seuil d'alerte par défaut | Clé |
|-------|---------------------------|-----|
| Espace disque | 85 % d'occupation | `tech_logs.system.disk_threshold_percent` |
| Mémoire | 90 % d'occupation | `tech_logs.system.memory_threshold_percent` |
| Swap | 50 % d'occupation | `tech_logs.system.swap_threshold_percent` |

Une alerte n'est émise qu'au **franchissement** du seuil, pas à chaque relevé.
Un retour sous le seuil produit un message de rétablissement.

> La surveillance du swap a un intérêt particulier ici : la machine dispose de
> 1,8 Go de mémoire et 2 Go de swap. Un recours durable au swap signale une fuite
> mémoire ou une charge anormale.

---

## 4. Masquage des données sensibles

**Appliqué avant tout envoi vers Discord**, sans exception. Un journal technique
n'est pas un flux de confiance : il peut contenir un jeton, un mot de passe ou une
donnée personnelle.

### Motifs masqués

Configurables via `tech_logs.redaction.patterns`. Au minimum :

| Cible | Traitement |
|-------|------------|
| Jetons Discord | `[masqué]` |
| Clés d'API, mots de passe, secrets | `[masqué]` |
| Contenu de variables d'environnement | `[masqué]` |
| Chemins absolus du système de fichiers | chemin relatif au projet |

### Adresses IP

**Deux traitements distincts, à ne pas confondre.**

| Origine | Traitement | Motif |
|---------|------------|-------|
| Adresse source d'une connexion SSH ou d'un bannissement fail2ban | **conservée en clair** | sans elle, un bannissement est illisible et une attaque impossible à analyser |
| Adresse apparaissant dans un journal applicatif du bot | **masquée** | elle ne peut provenir que d'un membre ; le bot n'a aucun besoin légitime de l'exposer |

Le masquage est appliqué par défaut ; la conservation en clair est une exception
limitée aux unités système listées ci-dessus.

> Point à confirmer : ce traitement différencié est une interprétation de la
> décision « oui pour les IP ». Si l'intention était de masquer les adresses SSH
> également, la clé `tech_logs.redaction.mask_ssh_ips` permet de le faire, au prix
> de journaux de sécurité inexploitables.

---

## 5. Limitation de débit

Discord plafonne le nombre de messages envoyés. Une erreur en boucle produirait
des centaines d'envois.

### Groupement

Même mécanisme qu'en phase 2, mais **clé indépendante** :
`tech_logs.grouping.window_seconds`. Les volumes et la criticité diffèrent de
ceux de la journalisation Discord, les deux fenêtres ne sont donc pas couplées.

### Plafond et condensation

| Paramètre | Valeur par défaut | Clé |
|-----------|-------------------|-----|
| Messages par minute et par salon | à fixer | `tech_logs.rate_limit.messages_per_minute` |

Au-delà du plafond, les entrées identiques sont condensées :
`47 erreurs identiques supprimées`.

L'identité de deux entrées se juge sur le type d'erreur et le module d'origine,
pas sur le message complet — un horodatage ou un identifiant variable ne doit pas
empêcher la condensation.

**L'écriture en base et en fichier n'est jamais limitée.** Seul l'affichage
Discord l'est.

---

## 6. Disjoncteur

Sans protection, un échec d'envoi vers Discord journalise une erreur, qui déclenche
un envoi, qui échoue, et ainsi de suite.

| Paramètre | Valeur par défaut | Clé |
|-----------|-------------------|-----|
| Échecs consécutifs avant coupure | 5 | `tech_logs.circuit_breaker.failure_threshold` |
| Durée de coupure | 5 minutes | `tech_logs.circuit_breaker.cooldown_seconds` |

Comportement :

1. Au-delà du seuil, le relais Discord est **coupé** pour la durée configurée.
2. Pendant la coupure, tout continue normalement en fichier et en base.
3. À l'expiration, un envoi de test est tenté. En cas de succès, le relais
   reprend avec un message signalant la coupure et sa durée.
4. **Aucune erreur d'envoi Discord n'est elle-même relayée vers Discord.** Elle va
   en fichier uniquement.

Ce dernier point n'est pas négociable : c'est la seule protection réelle contre la
boucle.

---

## 7. Stockage en base

Les entrées relayées sont enregistrées en base, en plus des fichiers.

Justification : permet la recherche a posteriori sans accès SSH à la machine, et
survit à la rotation des fichiers.

| Champ | Contenu |
|-------|---------|
| Source | `bot` ou `system` |
| Niveau | `error`, `warn`, `info` |
| Unité ou module d'origine | |
| Message | **après masquage** |
| Contexte structuré | JSON |
| Horodatage | |

**Le message est stocké après masquage**, jamais avant. La base n'a pas plus
vocation à contenir un jeton que le salon Discord.

---

## 8. Rétention

| Donnée | Durée par défaut | Clé |
|--------|------------------|-----|
| Journaux techniques en base | 14 jours | `tech_logs.retention.days` |
| Journaux en fichier | selon rotation du socle | — |

Le module déclare sa table au registre de purge du socle.

---

## 9. Tables

Schéma indicatif, à préciser à l'implémentation.

| Table | Contenu |
|-------|---------|
| `tech_logs` | source, niveau, origine, message masqué, contexte, horodatage |

---

## 10. Prérequis système

À effectuer sur le VPS, hors code :

1. Ajouter `cubexbot` au groupe `systemd-journal`.
2. Vérifier que la lecture de `journalctl` fonctionne sans `sudo` :
   `journalctl -u ssh -n 5`.
3. S'assurer que la rotation du journal systemd est active, pour que la lecture
   continue ne conserve pas un descripteur sur un fichier supprimé.

---

## 11. Points ouverts

1. **Plafond de messages par minute** — valeur par défaut à fixer après
   observation du volume réel.
2. **Traitement des adresses IP SSH** — à confirmer (voir section 4).
3. **Identifiants réels** des salons `bot` et `système VPS`.
