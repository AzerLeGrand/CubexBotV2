# Module sanctions et casier — Phase 3

Mémoire de modération. Le bot n'invente aucun mécanisme de sanction : il s'appuie
sur les fonctions natives de Discord et enregistre ce qui n'est pas conservé.

**Statut :** figé le 11 août 2026.
**Prérequis :** socle (`00-socle.md`) et journalisation Discord (`02-logs-discord.md`).

---

## 1. Portée et intention

### Ce que Discord fait déjà

Exclusion temporaire, expulsion, bannissement, AutoMod et journal d'audit sont
natifs. **Ils ne sont pas réimplémentés.** Aucun système de mute par rôle : c'est
fragile, contournable, et ça duplique une fonction de la plateforme.

### Ce que Discord ne fait pas

- Aucun historique de sanctions consultable.
- Le journal d'audit est purgé au bout de 90 jours.
- Aucune notion d'antécédent : un récidiviste revenu huit mois plus tard est
  invisible.

**Le module construit la mémoire de la modération, pas la modération.**

### Choix assumés

- **Pas d'avertissements.** Le système de warns est écarté : le timeout natif
  suffit.
- **Pas d'escalade automatique.** Aucun seuil ne déclenche de sanction.
- **Pas de bannissement temporaire.** Discord ne le propose pas nativement ; le
  simuler exigerait que le bot soit en ligne à l'échéance exacte. Tous les
  bannissements sont permanents.
- **Pas de message privé au membre sanctionné.**

---

## 2. Sources d'alimentation du casier

Trois sources, toutes enregistrées.

| Source | Mécanisme |
|--------|-----------|
| Commandes du bot | enregistrement direct au moment de l'exécution |
| Interface Discord (clic droit, menu de modération) | capté via le journal d'audit, phase 2 |
| AutoMod | capté via l'intent `AutoModerationExecution` |

**Justification.** Limiter le casier aux commandes du bot le rendrait faux dès
qu'un modérateur utilise l'interface Discord — ce qui arrivera, parce que c'est
plus rapide. Un casier incomplet est pire qu'un casier absent : il donne
l'illusion de l'exhaustivité.

### Séparation d'AutoMod

Les déclenchements AutoMod sont enregistrés dans une **catégorie distincte** des
sanctions.

Un mot filtré n'a pas le poids d'un bannissement. Mélangés, les déclenchements
AutoMod — potentiellement nombreux et anodins — noieraient les vraies sanctions
dans l'affichage du casier.

---

## 3. Commandes

| Commande | Rôle |
|----------|------|
| `/ban` | bannissement permanent |
| `/unban` | levée de bannissement |
| `/untimeout` | levée d'exclusion temporaire avant échéance |
| `/casier` | consultation de l'historique d'un membre |

### Absences volontaires

Il n'existe **pas** de commande d'application de timeout ni de kick. Ces actions
se font par l'interface Discord, plus rapide, et sont récupérées par le journal
d'audit. Le bot ne sert qu'à **lever** une exclusion temporaire, opération moins
accessible dans l'interface.

### Motif

**Obligatoire pour toute commande du bot.** Une commande sans motif est refusée.

Cette contrainte ne peut pas s'appliquer aux autres sources : un modérateur
bannissant par clic droit peut laisser le champ vide, et AutoMod n'en fournit
aucun. Dans ces cas, le casier enregistre un motif vide et l'affiche comme
**« non renseigné »**.

### Transmission à Discord

Le motif est transmis dans l'en-tête `X-Audit-Log-Reason` lors de chaque appel à
l'API. Il apparaît alors dans le journal d'audit natif, ce qui rend les sanctions
du bot lisibles même sans lui.

---

## 4. Suivi de l'état

**Le casier reflète l'état actuel, pas seulement l'historique des événements.**

Chaque sanction porte un statut. Une levée met à jour la ligne existante, avec la
date et l'auteur de la levée.

| Statut | Signification |
|--------|---------------|
| `active` | sanction en cours |
| `lifted` | levée manuellement, par commande ou par l'interface Discord |
| `expired` | échéance atteinte (exclusions temporaires) |

**La sanction initiale reste visible en toutes circonstances.** Une levée n'efface
rien : elle ajoute une information. Un ban levé après trois mois reste un ban dans
l'historique.

Une levée effectuée depuis l'interface Discord est captée par le journal d'audit
et met à jour le statut au même titre qu'une commande du bot.

---

## 5. Consultation

### Commande

`/casier <membre> [type] [page]`

### Contenu affiché

Par entrée : type de sanction, date, durée le cas échéant, motif, modérateur,
statut, date et auteur de la levée s'il y a lieu.

### Filtrage

Filtre par type de sanction. Sans filtre, toutes les sanctions sont affichées ;
les déclenchements AutoMod restent dans leur catégorie séparée et ne se mélangent
pas aux sanctions.

### Pagination

Nombre d'entrées par page configurable. Navigation par boutons.

**Contrainte de persistance :** comme pour le module de vérification, les boutons
de pagination doivent utiliser des identifiants de composant fixes pour rester
fonctionnels après un redémarrage du bot.

### Visibilité

**Réponse éphémère**, visible du seul demandeur.

### Permissions

Toute la hiérarchie de modération, de `Trainee` à `Owner`. Configurable via
`commands.casier.allowed_roles`.

Un membre ne peut pas consulter son propre casier.

---

## 6. Rétention

| Donnée | Durée |
|--------|-------|
| Sanctions (ban, unban, timeout, kick) | **sans limite** |
| Déclenchements AutoMod | voir rétention des événements structurels, phase 2 |

**Justification.** C'est la seule donnée que Discord ne conserve pas au-delà de
90 jours, et le volume est dérisoire. Un récidiviste revenant après un an doit
rester identifiable.

Ce choix ferme le point ouvert n°1 du socle.

**Conséquence à assumer.** Conserver indéfiniment des données de sanction sur des
personnes, dont potentiellement des mineurs, est une décision prise en
connaissance de cause. La commande de suppression sur demande prévue au socle
reste le recours ; son articulation avec la conservation illimitée relève du volet
légal, à traiter séparément.

Les sanctions sont **exclues du registre de purge**. Les déclenchements AutoMod y
sont déclarés.

---

## 7. Restitution dans Discord

Les sanctions sont affichées dans le salon **modération** défini en phase 2.
Aucun salon supplémentaire.

Les sanctions prises par commande du bot n'y sont pas envoyées deux fois : la
capture par le journal d'audit doit détecter que l'événement provient du bot
lui-même et ne pas le dupliquer.

---

## 8. Tables

Schéma indicatif, à préciser à l'implémentation.

| Table | Contenu |
|-------|---------|
| `sanctions` | identifiant du membre, type, motif, modérateur, source, horodatage, durée, statut, date de levée, auteur de la levée |
| `automod_triggers` | identifiant du membre, règle déclenchée, action appliquée, salon, horodatage |

Champ `source` : `command`, `discord_ui`, `automod`. Il permet de distinguer
l'origine et d'expliquer un motif vide.

---

## 9. Intents et permissions

| Élément | Usage |
|---------|-------|
| `GuildModeration` | événements de bannissement |
| `GuildMembers` | exclusions temporaires, départs |
| `AutoModerationExecution` | déclenchements AutoMod |
| Permission `View Audit Log` | capture des sanctions prises hors du bot |
| Permission `Ban Members` | commandes `/ban` et `/unban` |
| Permission `Moderate Members` | commande `/untimeout` |

**Prérequis de hiérarchie :** le rôle du bot doit être positionné au-dessus des
rôles des membres qu'il doit sanctionner. Un bot ne peut agir sur un membre dont
le rôle le plus élevé est au-dessus du sien.

---

## 10. Points ouverts

1. **Nombre d'entrées par page** du casier — valeur par défaut à fixer.
2. **Tolérance de déduplication** entre une sanction émise par commande et sa
   capture ultérieure dans le journal d'audit.
3. **Articulation entre conservation illimitée et droit à l'effacement** — à
   traiter dans le volet légal.
