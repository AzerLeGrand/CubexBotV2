-- Tables du module de vérification (phase 1, sections 7 et 8).
--
-- Une seule migration pour les trois tables : chaque fichier s'applique dans sa
-- propre transaction, et trois fichiers laisseraient un schéma à moitié créé si
-- le deuxième échouait. Les trois tables et leurs index forment un seul schéma,
-- créé à un seul moment.
--
-- Aucun DEFAULT sur les horodatages. Ils sont écrits par le code, via
-- toISOString(). Un défaut en SQL n'ajouterait qu'une seconde façon d'écrire un
-- horodatage, donc une seconde façon de se tromper -- et datetime('now'), avec
-- son espace au lieu du T, ferait passer toutes les lignes du jour pour
-- antérieures au seuil de purge : une erreur d'une journée, tous les jours.

-- État d'une vérification EN COURS ou BLOQUÉE. Rien d'autre.
--
-- AUCUNE COLONNE « VÉRIFIÉ ». La source de vérité est le rôle Member sur
-- Discord, jamais la base : un membre à qui le staff retire le rôle à la main
-- doit repasser la vérification. Une colonne ici dirait le contraire, et il
-- faudrait arbitrer laquelle des deux gagne — arbitrage qu'on perdrait de vue
-- avant la fin de la phase 2.
--
-- À la réussite, la ligne est SUPPRIMÉE plutôt que remise à zéro. Un membre
-- vérifié n'a plus rien à faire ici, et un membre bloqué ne peut pas réussir :
-- supprimer ne perd donc aucun blocage. La table ne contient que ce qui est en
-- cours, ce qui la garde petite et lisible ; l'historique vit dans
-- verification_history, qui est fait pour ça.
CREATE TABLE verification_state (
  -- Identifiant Discord, TEXT sans exception : au-delà de 16 chiffres, un
  -- entier est tronqué silencieusement. C'est la panne qui a arrêté la version
  -- précédente du bot.
  user_id     TEXT    NOT NULL PRIMARY KEY,
  attempts    INTEGER NOT NULL DEFAULT 0,
  -- Le blocage est STOCKÉ, jamais déduit de « attempts >= max_attempts ».
  -- max_attempts est configurable : le passer de 5 à 3 bloquerait
  -- rétroactivement des membres qui n'ont rien fait, le passer à 8 débloquerait
  -- en silence des comptes que le staff a laissés bloqués volontairement. Le
  -- seuil décide du moment où l'on bloque, il ne définit pas ce qu'être bloqué
  -- veut dire.
  blocked_at  TEXT    NULL,
  updated_at  TEXT    NOT NULL
);

-- Historique des événements, soumis à rétention (verification.retention.history_days).
CREATE TABLE verification_history (
  id          INTEGER NOT NULL PRIMARY KEY,
  user_id     TEXT    NOT NULL,
  -- success | failure | block | unblock. Les valeurs sont des constantes du
  -- module et non de la configuration : elles sont écrites en base et relues
  -- par le code, les rendre configurables casserait les lignes existantes au
  -- premier renommage. Exception assumée à la règle « aucune valeur codée en
  -- dur » -- voir constants.js.
  --
  -- Pas de contrainte CHECK : SQLite ne sait pas la modifier, et ajouter un
  -- cinquième type d'événement imposerait de reconstruire une table portant
  -- l'historique de tous les membres. Ce qu'on protégerait est mince, les
  -- valeurs venant d'un jeu de constantes sans saisie ni appelant extérieur.
  event       TEXT    NOT NULL,
  -- Membre du staff auteur de l'action, sur unblock uniquement. Donnée
  -- personnelle : elle est anonymisée, pas supprimée, à l'effacement de ce
  -- modérateur — voir le commentaire d'erasure dans index.js.
  actor_id    TEXT    NULL,
  created_at  TEXT    NOT NULL
);

-- Sert la recherche par membre : historique d'un membre, et effacement.
CREATE INDEX idx_verification_history_user_id ON verification_history (user_id);

-- Sert la purge, qui balaie par date.
CREATE INDEX idx_verification_history_created_at ON verification_history (created_at);

-- Message permanent du salon de vérification.
--
-- Clé primaire sur channel_id, et non une ligne unique forcée : si le salon
-- change dans config.yml, le bot publie dans le nouveau et l'ancienne ligne
-- devient inerte au lieu d'être écrasée. Aucun risque de republier dans un
-- salon qu'on a quitté.
--
-- Ne porte aucune donnée de membre : rien à déclarer au registre d'effacement.
CREATE TABLE verification_message (
  channel_id  TEXT NOT NULL PRIMARY KEY,
  message_id  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
