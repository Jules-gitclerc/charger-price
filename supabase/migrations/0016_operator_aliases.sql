-- Migration 0016 — Operator aliases (T08, M1 W4)
--
-- T08, M1 W4. Closes the deferred-FK loop opened in 0002:
-- live.stations.operator_id and live.stations.network_id were declared
-- nullable FK in 0002 with a comment "T08 (W3) populates operator_aliases
-- and starts assigning stations.operator_id". This migration creates the
-- alias tables, seeds canonical operators + their aliases, and registers
-- the operator_resolver source. The resolver runner (T08.2,
-- tools/operator-resolver/) issues the actual UPDATE pass over
-- live.stations.
--
-- WHY HAND-ROLLED SQL (not Drizzle-Kit generated):
--   Strict-normalization CHECK constraints on alias_text, the JOIN-by-slug
--   alias seed pattern (uuid PK on operators forces lookup), and the
--   long-form COMMENTs documenting the modeling decisions are clearer in
--   raw SQL.
--
-- IDEMPOTENCY: every CREATE uses IF NOT EXISTS. Every INSERT uses
-- ON CONFLICT DO NOTHING. Re-applying 0016 after manual operator
-- additions in M2 is safe.
--
-- ENTITIES (per docs/02-architecture.md §1.2 + T08 brief):
--   operator_aliases — alias_text → operator_id mapping. The resolver
--                      JOINs lower(btrim(stations.nom_enseigne)) =
--                      alias_text. PK is the normalized form so duplicate
--                      casings cannot resolve to different operators.
--   network_aliases  — same shape, FK to live.networks. EMPTY in 0016
--                      by design (Q3): T08 only writes operator_id.
--                      M2+ may populate (e.g. distinguishing
--                      "TotalEnergies Charge Rapide" as a network under
--                      operator "totalenergies").
--
-- DESIGN CALLS (per T08.0 + T08.1 review):
--
-- D1 — Single migration, structure + seed together:
--   The implementation plan §T08 originally split tables vs seed across
--   files. We bundle into one migration because (a) the seed is
--   meaningless without the structure, (b) re-running migrations in a
--   fresh environment requires both, (c) "structural + minimal seed" is
--   the established pattern (cf. 0005 sources seed). E22 forward-practice.
--
-- D2 — alias_text PK normalized, not raw:
--   The PK is the lower(btrim(...)) form. CHECK enforces it. This
--   guarantees the resolver's JOIN key cannot have duplicate-casing
--   hazards (LIDL vs lidl resolving to different operators). Display
--   form is recoverable from the live.stations row that originated it
--   (audit purpose) — we don't need to re-store it on the alias row.
--
-- D3 — confidence column reserved with three values, only 'curated' used:
--   `confidence` accepts 'curated', 'fuzzy', 'prefix'. All 0016 rows are
--   'curated' (hand-mapped from Phase 1 A.1 + the T08.0 probe). Carrying
--   the column now avoids an ALTER later when M1.5 adds prefix-rule
--   resolution for the long tail (E23). Per docs/01-discovery.md the
--   long-tail Allego/TotalEnergies/Fastned site-suffix pattern is real
--   enough that the schema should reserve room for it.
--
-- D4 — Materiality threshold ≥6 stations for alias inclusion:
--   Aliases below 6-station volume are not seeded. T08.0 probe found
--   one lone-variant 'révéo' at 1 station that would qualify on a
--   strict alias-spelling basis but doesn't justify a row. The 'tesla
--   supercharger' alias at exactly 6 stations sits at the floor and is
--   kept; this fixes 6 as the de facto materiality bar for any future
--   contributor proposing additions.
--
-- D5 — Power Dot owns LIDL aliases (Phase 1 §A.1 §1):
--   `LIDL` and `Lidl France` are co-branded enseignes on stations
--   actually operated by Power Dot. Modeled as two aliases on a single
--   `power-dot` operator. M2 may want a station-level co-branding tag
--   if the UX surfaces "LIDL stations" as a filter — that's a
--   downstream concern, not an operator-level one.
--
-- D6 — Izivia: one operator, four tariff-tier aliases:
--   IZIVIA FAST, IZIVIA Impact, Izivia Express, IZIVIA MAX are tariff
--   tiers of EDF subsidiary Izivia, not separate operators. Same
--   modeling as eborn (eborn + Réseau eborn) and Reveo (reveo +
--   Révéo 2025). Future network-level disambiguation deferred to M2.
--
-- D7 — Long-tail enseigne pattern deferred (E23):
--   Allego, TotalEnergies, Fastned operators inject site names into
--   nom_enseigne ("Allego - Carrefour Wasquehal", "TotalEnergies -
--   Compiègne", "fastned aire de saint-julien"). The `fastned` operator
--   row is seeded so T14 (M1.5) scraper can FK against it, but the
--   `'fastned'` alias is NOT seeded — zero stations match it as a
--   clean enseigne. Long-tail prefix-rule alias (`confidence='prefix'`,
--   LIKE-based matching) deferred to M1.5+ pending real-volume data.
--
-- D8 — operator_resolver source kind = 'parser':
--   live.sources.kind enum is dataset|parser|scraper|correction (0005).
--   No 'enrichment' value. The resolver normalizes structured nom_enseigne
--   values via the alias table — closest semantic fit is 'parser' (it
--   parses the alias_text out of an enseigne string). Priority sits in
--   the parser band (200-500). If 'enrichment' becomes a recognized kind
--   in M2, ALTER the CHECK then.
--
-- D9 — Source row in migration, not in runner:
--   Differs from T07 (BAN reverse-geocode) which ensures its source
--   row at runner startup. Bundled here because we already have
--   operator/alias seed in 0016 — schema-as-source-of-truth is the
--   simpler pattern. Either approach works; surface in T08 closing as
--   a minor pattern divergence to standardize on in M2.

-- ─────────────────────────────────────────────────────────────────────────
-- operator_aliases
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.operator_aliases (
  -- PK is the normalized form (lower-btrim of the source enseigne).
  -- CHECK enforces normalization at write time so the resolver's JOIN
  -- on lower(btrim(stations.nom_enseigne)) = alias_text is safe.
  alias_text   text         PRIMARY KEY,
  operator_id  uuid         NOT NULL REFERENCES live.operators(id) ON DELETE CASCADE,
  confidence   text         NOT NULL DEFAULT 'curated',
  created_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT operator_aliases_alias_text_normalized CHECK (
    alias_text = lower(btrim(alias_text)) AND alias_text <> ''
  ),
  CONSTRAINT operator_aliases_confidence_enum CHECK (
    confidence IN ('curated', 'fuzzy', 'prefix')
  )
);

CREATE INDEX IF NOT EXISTS operator_aliases_operator_idx
  ON live.operator_aliases (operator_id);

COMMENT ON TABLE live.operator_aliases IS
  'Maps normalized nom_enseigne (lower(btrim(...))) to canonical operator. Resolver (tools/operator-resolver/, T08.2) JOINs lower(btrim(live.stations.nom_enseigne)) = alias_text. PK normalization eliminates duplicate-casing hazards. Materiality threshold for inclusion: aliases must cover ≥6 live.stations rows (D4); single-station enseignes deferred. confidence column reserves room for future prefix-rule (E23) and fuzzy-match additions; all curated rows seeded in 0016 are confidence=''curated''.';
COMMENT ON COLUMN live.operator_aliases.alias_text IS
  'Normalized form: lower(btrim(nom_enseigne)). CHECK-enforced. Safe to JOIN against the same expression on live.stations.nom_enseigne.';
COMMENT ON COLUMN live.operator_aliases.confidence IS
  'curated | fuzzy | prefix. 0016 seeds only curated rows. fuzzy/prefix reserved for M1.5+ long-tail resolution per E23.';

-- ─────────────────────────────────────────────────────────────────────────
-- network_aliases (structure only — empty in 0016 by design, Q3)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.network_aliases (
  alias_text   text         PRIMARY KEY,
  network_id   uuid         NOT NULL REFERENCES live.networks(id) ON DELETE CASCADE,
  confidence   text         NOT NULL DEFAULT 'curated',
  created_at   timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT network_aliases_alias_text_normalized CHECK (
    alias_text = lower(btrim(alias_text)) AND alias_text <> ''
  ),
  CONSTRAINT network_aliases_confidence_enum CHECK (
    confidence IN ('curated', 'fuzzy', 'prefix')
  )
);

CREATE INDEX IF NOT EXISTS network_aliases_network_idx
  ON live.network_aliases (network_id);

COMMENT ON TABLE live.network_aliases IS
  'Same shape as operator_aliases but FK to live.networks. EMPTY in 0016 by design — T08 (Q3) only writes operator_id. M2+ may populate when distinguishing sub-networks under one operator (e.g. "TotalEnergies Charge Rapide" as a network under operator "totalenergies") becomes UX-relevant.';

-- ─────────────────────────────────────────────────────────────────────────
-- Operator seed (34 canonical brands)
--
-- One row per real-world operator. Slug is lowercase, no whitespace
-- (enforced by 0002's operators_slug_lowercase CHECK). Display name
-- preserves accents and punctuation. Country code is the operator's
-- country of incorporation when known, else 'FR' (the 0002 default).
--
-- Coverage measured pre-commit (T08.1): 29,446 of 52,806 live.stations
-- rows = 55.8%. Locked acceptance bar for T08.2 resolver — anything
-- less is a bug, anything more indicates alias drift between seed and
-- resolver. This seed targets the materiality-≥6 (D4) brands surfaced
-- by the T08.0 probe; the long tail (~70 small public-tender CPOs and
-- ~1k Allego/TotalEnergies/Fastned site-suffix variants) stays
-- operator_id NULL by design pending E23 prefix-rule work.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO live.operators (slug, display_name, country) VALUES
  ('allego',                'Allego',                              'NL'),
  ('belib',                 'Belib''',                             'FR'),
  ('chargeguru',            'ChargeGuru',                          'FR'),
  ('citeos-mobive',         'CITEOS Mobive',                       'FR'),
  ('driveco',               'DRIVECO',                             'FR'),
  ('eborn',                 'eborn',                               'FR'),
  ('edf',                   'EDF (EV100)',                         'FR'),
  ('electra',               'Electra',                             'FR'),
  ('electric-55',           'Electric 55 Charging',                'FR'),
  ('engie-vianeo',          'ENGIE Vianeo',                        'FR'),
  ('evzen',                 'EVzen',                               'FR'),
  ('fastned',               'Fastned',                             'NL'),
  ('freshmile',             'Freshmile',                           'FR'),
  ('groupe-indigo',         'Réseau de recharge du groupe Indigo', 'FR'),
  ('ionity',                'Ionity',                              'DE'),
  ('izivia',                'Izivia',                              'FR'),
  ('le-plein-tarnais',      'Le Plein Tarnais',                    'FR'),
  ('les-mousquetaires',     'Les Mousquetaires',                   'FR'),
  ('ouest-charge',          'Ouest Charge',                        'FR'),
  ('pass-pass-electrique',  'Pass pass électrique',                'FR'),
  ('power-dot',             'Power Dot',                           'PT'),
  ('qovoltis',              'Qovoltis',                            'FR'),
  ('qpark',                 'Q-Park',                              'NL'),
  ('reveo',                 'Révéo',                               'FR'),
  ('sdec',                  'SDEC ÉNERGIE',                        'FR'),
  ('seymaborne',            'SEYMA Borne',                         'FR'),
  ('soregies',              'Sorégies Mobilités',                  'FR'),
  ('stations-e',            'Stations-e',                          'FR'),
  ('systeme-u',             'Système U',                           'FR'),
  ('tesla',                 'Tesla',                               'US'),
  ('totalenergies',         'TotalEnergies',                       'FR'),
  ('virta',                 'Virta Public',                        'FI'),
  ('waat',                  'WAAT',                                'FR'),
  ('ze-watt',               'Ze-Watt',                             'FR')
ON CONFLICT (slug) DO NOTHING;

-- D5 / D6 / D7 modeling COMMENTs at row scope — attached to operators
-- via setting per-row description (no description column on operators);
-- captured here in the migration text as the canonical record.
--
-- power-dot:    LIDL + Lidl France resolve here per Phase 1 §A.1 §1.
-- izivia:       FAST/Impact/Express/MAX are tariff tiers (EDF subsidiary), not separate operators.
-- eborn:        eborn + Réseau eborn — same commercial entity, French CPO convention.
-- reveo:        REVEO + Reveo + Révéo 2025 — Occitanie regional, single operator.
-- soregies:     Sorégies Mobilités + Sorégies — Vienne regional utility, two enseignes.
-- tesla:        Tesla + Tesla Supercharger — at the materiality floor (6 stations on Supercharger variant).
-- totalenergies: Charge Rapide + Charging Services seeded; "TotalEnergies - <site>" tail NULL by design (D7).
-- allego:       single ALLEGO alias seeded; "Allego - <site>" tail (~200 stations) NULL by design (D7).
-- fastned:      operator row only; ZERO clean-enseigne aliases — all 62 live rows use site-suffix pattern (D7). T14 scraper writes verified rows directly.

-- ─────────────────────────────────────────────────────────────────────────
-- Alias seed (44 normalized aliases mapping to the 33 operators)
--
-- alias_text values are the lower(btrim(...)) form of the actual
-- nom_enseigne in live.stations (verified via T08.0 probe). UTF-8
-- accented characters preserved verbatim where present in upstream
-- (réseau eborn, pass pass électrique, etc.); accent-stripping is NOT
-- applied because Postgres lower() is locale-aware UTF-8 and the
-- upstream data carries accents inconsistently (Sorégies Mobilités
-- arrives as 'soregies mobilites' without accents — verified probe).
--
-- JOIN-by-slug pattern: VALUES (alias, op_slug) joined to operators
-- on slug. Tolerant of operator-id regeneration on re-apply
-- (operators.id is uuid generated, alias_text → operator_id binding
-- resolves at insert time).
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO live.operator_aliases (alias_text, operator_id, confidence)
SELECT v.alias_text, o.id, 'curated' AS confidence
FROM (VALUES
  ('allego',                              'allego'),
  ('belib''',                             'belib'),
  ('chargeguru',                          'chargeguru'),
  ('cpo citeos mobive',                   'citeos-mobive'),
  ('driveco',                             'driveco'),
  ('eborn',                               'eborn'),
  ('réseau eborn',                        'eborn'),
  ('edf-ev100',                           'edf'),
  ('electra',                             'electra'),
  ('electric 55 charging',                'electric-55'),
  ('engie vianeo',                        'engie-vianeo'),
  ('evzen',                               'evzen'),
  ('freshmile',                           'freshmile'),
  ('freshmile france',                    'freshmile'),
  ('réseau de recharge du groupe indigo', 'groupe-indigo'),
  ('ionity gmbh',                         'ionity'),
  ('izivia fast',                         'izivia'),
  ('izivia impact',                       'izivia'),
  ('izivia express',                      'izivia'),
  ('izivia max',                          'izivia'),
  ('le plein tarnais',                    'le-plein-tarnais'),
  ('les mousquetaires',                   'les-mousquetaires'),
  ('ouest charge',                        'ouest-charge'),
  ('pass pass électrique',                'pass-pass-electrique'),
  ('lidl',                                'power-dot'),
  ('lidl france',                         'power-dot'),
  ('power dot france',                    'power-dot'),
  ('qovoltis',                            'qovoltis'),
  ('qpark',                               'qpark'),
  ('reveo',                               'reveo'),
  ('révéo 2025',                          'reveo'),
  ('sdec energie',                        'sdec'),
  ('seymaborne',                          'seymaborne'),
  ('soregies',                            'soregies'),
  ('soregies mobilites',                  'soregies'),
  ('stations-e',                          'stations-e'),
  ('systeme u',                           'systeme-u'),
  ('tesla',                               'tesla'),
  ('tesla supercharger',                  'tesla'),
  ('totalenergies charge rapide',         'totalenergies'),
  ('totalenergies charging services',     'totalenergies'),
  ('réseau de recharge virta public',     'virta'),
  ('waat',                                'waat'),
  ('réseau de recharge ze-watt',          'ze-watt')
) AS v(alias_text, op_slug)
JOIN live.operators o ON o.slug = v.op_slug
ON CONFLICT (alias_text) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- live.sources row for operator_resolver
--
-- Per D8: kind='parser', priority sits in the parser band (200-500).
-- 220 chosen to sit just above driveco_irve_json (200) and citeos
-- (210) — operator resolution is downstream of those parsers
-- conceptually. Priority is mostly meaningless for T08 (operator_id
-- has no station_tariffs-style multi-source conflict semantics) but
-- band-following keeps the catalog coherent.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO live.sources (slug, kind, priority, display_name, description) VALUES
  ('operator_resolver',
   'parser',
   220,
   'Operator alias resolver (T08)',
   'Resolves live.stations.operator_id by JOINing lower(btrim(nom_enseigne)) against live.operator_aliases. One-shot runner under tools/operator-resolver/ (T08.2). Registered as kind=''parser'' for ingestion_runs FK consistency; the resolver normalizes structured enseigne values rather than parsing free-text but ''parser'' is the closest semantic fit in the existing kind enum (dataset|parser|scraper|correction).')
ON CONFLICT (slug) DO NOTHING;
