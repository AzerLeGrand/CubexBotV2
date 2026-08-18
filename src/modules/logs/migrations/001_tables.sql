-- Tables du module de journalisation Discord (phase 2, sections 6, 9 et 10).
--
-- Une seule migration pour les deux tables : chaque fichier s'applique dans sa
-- propre transaction, et deux fichiers laisseraient un schéma à moitié créé si
-- le second échouait. Les deux tables, leur clé étrangère et leurs index forment
-- un seul schéma, créé à un seul moment.
--
-- Aucun DEFAULT sur les horodatages. Ils sont écrits par le code, via
-- toISOString(). datetime('now') produit un espace au lieu du T : l'espace
-- (0x20) précède le T (0x54) en binaire, et toutes les lignes du jour passeraient
-- pour antérieures au seuil de purge. Une erreur d'une journée, tous les jours.

-- Métadonnées de tout événement journalisé. Rétention longue
-- (logs.retention.structural_days).
--
-- SÉPARÉE DU CONTENU, délibérément : c'est ce qui permet de purger les contenus
-- de messages à 30 jours tout en conservant les métadonnées à 90. Une seule
-- table imposerait une rétention unique, donc la plus courte des deux.
CREATE TABLE log_events (
  -- AUTOINCREMENT et non le rowid ordinaire : sans lui, SQLite réattribue
  -- l'identifiant des lignes supprimées, et la purge en supprime tous les jours.
  -- Un identifiant réutilisé rattacherait un ancien contenu à un nouvel
  -- événement si la clé étrangère venait à ne pas être appliquée -- par un
  -- sqlite3 ouvert en SSH, où le pragma foreign_keys est inactif par défaut.
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Valeur de LOG_EVENTS, dans constants.js. Écrite en base et relue par le
  -- code : c'est un format, pas un réglage.
  event_type          TEXT    NOT NULL,
  -- ISO 8601 strict en TEXT, avec le T et en UTC : 2026-08-18T14:32:07.512Z.
  -- Le registre de purge inspecte la première valeur non nulle et refuse la
  -- table si la forme dévie.
  occurred_at         TEXT    NOT NULL,
  -- Auteur de l'action. NULL quand le journal d'audit ne dit rien -- Discord
  -- n'y inscrit rien quand un membre supprime son propre message. Donnée
  -- personnelle ANONYMISÉE, jamais supprimée : voir erasure dans index.js.
  actor_id            TEXT    NULL,
  -- certain | probable | unknown. La corrélation avec le journal d'audit se
  -- fait sur le salon, la cible et une fenêtre temporelle : elle est faillible,
  -- et la spec §3 interdit toute affirmation catégorique. La certitude est
  -- STOCKÉE et non recalculée à l'affichage, la fenêtre de corrélation étant
  -- configurable -- la relire changerait rétroactivement la certitude de
  -- lignes déjà écrites.
  --
  -- CHECK ici, alors que verification_history s'en passe : ce jeu de trois
  -- valeurs décrit une propriété de la corrélation, pas une liste d'événements
  -- qu'on étendra. Il n'y a pas de quatrième degré de certitude à prévoir.
  actor_confidence    TEXT    NOT NULL
                      CHECK (actor_confidence IN ('certain', 'probable', 'unknown')),
  -- Membre concerné par l'action. Anonymisée elle aussi : la trace garde sa
  -- valeur sans son porteur.
  target_id           TEXT    NULL,
  -- Salon concerné. NULL sur ce qui ne s'y rattache pas : guild_update,
  -- role_create, member_ban.
  channel_id          TEXT    NULL,
  -- live | catchup. Les événements rattrapés après une coupure sont signalés
  -- comme tels dans les salons Discord (spec §8) : sans la mention, des
  -- événements datés de la veille apparaîtraient sans explication.
  source              TEXT    NOT NULL CHECK (source IN ('live', 'catchup')),
  -- Entrée du journal d'audit à l'origine de la ligne, quand il y en a une.
  -- Sert au dédoublonnage du rattrapage.
  audit_log_entry_id  TEXT    NULL,
  -- JSON, sérialisé par le code. Porte ce qui est propre à chaque type
  -- d'événement -- ancien et nouveau nom d'un salon, rôles ajoutés, règle
  -- AutoMod déclenchée -- sans imposer une colonne par cas ni une migration à
  -- chaque nouvel événement.
  data                TEXT    NOT NULL
);

-- Sert /history du lot 6 : les événements d'un membre, du plus récent au plus
-- ancien. L'ordre est porté par l'index pour éviter un tri sur la table
-- entière.
CREATE INDEX idx_log_events_target_id ON log_events (target_id, occurred_at DESC);

-- Sert la purge, qui balaie par date.
CREATE INDEX idx_log_events_occurred_at ON log_events (occurred_at);

-- Dédoublonnage du rattrapage : une entrée d'audit déjà enregistrée en direct
-- ne doit pas être réécrite au redémarrage.
--
-- SQLite tolère plusieurs NULL dans un index unique -- ils ne sont jamais égaux
-- entre eux au sens de la contrainte. Les événements sans entrée d'audit, qui
-- sont la majorité, ne se gênent donc pas.
CREATE UNIQUE INDEX idx_log_events_audit_log_entry_id ON log_events (audit_log_entry_id);

-- Contenu des messages supprimés ou modifiés. Rétention courte
-- (logs.retention.message_content_days).
CREATE TABLE log_message_content (
  -- Clé primaire ET clé étrangère : un événement porte au plus un contenu.
  -- Le CASCADE joue quand la purge des métadonnées passe -- à 90 jours, le
  -- contenu est parti depuis 60.
  event_id        INTEGER NOT NULL PRIMARY KEY
                  REFERENCES log_events (id) ON DELETE CASCADE,
  -- DUPLIQUE occurred_at de l'événement, et ce n'est pas une redondance à
  -- corriger : le registre de purge exige une colonne de date sur la table
  -- QU'IL PURGE, et les deux tables ont des rétentions différentes. Sans cette
  -- colonne, le contenu ne pourrait être purgé qu'avec les métadonnées, donc à
  -- 90 jours au lieu de 30.
  created_at      TEXT    NOT NULL,
  -- Auteur du message. Existe pour l'effacement RGPD : sans elle, la table
  -- serait inatteignable par le registre, et le contenu des messages d'un
  -- membre -- la donnée la plus personnelle que le bot conserve -- survivrait à
  -- sa demande d'effacement. Ici la stratégie est DELETE, pas anonymize : le
  -- contenu EST la donnée personnelle, il n'a aucune valeur de trace sans elle.
  author_id       TEXT    NULL,
  content_before  TEXT    NULL,
  content_after   TEXT    NULL,
  -- JSON : nom, taille et nombre des fichiers. Les fichiers eux-mêmes ne sont
  -- pas téléchargés (spec §3) -- ce serait stocker les fichiers des membres sur
  -- le VPS, avec le coût et l'exposition juridique que cela implique. Leur URL
  -- pointe de toute façon vers une ressource effacée.
  attachments     TEXT    NULL
);

-- Sert la purge quotidienne, qui balaie cette table par date au même titre que
-- log_events. Ajouté au-delà de la liste d'index de la spec, pour la même
-- raison qui a fait poser idx_log_events_occurred_at : c'est la table la plus
-- volumineuse du projet, et la purge y passe tous les jours.
CREATE INDEX idx_log_message_content_created_at ON log_message_content (created_at);
