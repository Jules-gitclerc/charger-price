-- Migration 0011 — staging.irve_raw + staging.ingestion_run_meta
--
-- T06a, M1 W3. First migration in the T06 ingestion spine.
--
-- T06a brief reference: this migration is a permanent-infrastructure
-- prerequisite to the T06a Python runner under tools/irve-sync/. The
-- runner TRUNCATEs staging.irve_raw at the start of each run, COPYs the
-- IRVE consolidated CSV into it, then leaves it for T06b's diff-and-swap
-- function (migration 0012) to read.
--
-- WHY HAND-ROLLED SQL (not Drizzle-Kit generated):
--   Drizzle's column DSL doesn't naturally express the "all columns text +
--   nullable, exactly mirroring the upstream CSV header" shape we need for
--   forgiving COPY. Hand-rolling also keeps the column order matching the
--   CSV header in https://www.data.gouv.fr/api/1/datasets/r/eb76d20a-… for
--   debuggability when reading raw rows in psql.
--
-- IDEMPOTENCY: every CREATE uses IF NOT EXISTS. Re-applying this migration
-- against a populated staging is a no-op; it does NOT truncate.
--
-- C1 — `_ingestion_run_id` IS NOT a foreign key (deliberate)
--   The column is `uuid NOT NULL` but carries no REFERENCES clause to
--   live.ingestion_runs(id). Two reasons:
--     1. TRUNCATE incompatibility. The Python runner TRUNCATEs this table
--        at the start of every IRVE sync. With a NOT-NULL FK to live.*,
--        TRUNCATE without CASCADE fails on referenced rows; with CASCADE,
--        we'd cascade across the schema boundary and orphan ingestion_runs
--        history. Neither is acceptable.
--     2. Schema isolation. staging.* is per-run scratch; live.* is durable.
--        A constraint pulling the two together violates the architectural
--        rule established in 0001 (and docs/02-architecture.md §2.5).
--   The relationship is logical-only: "this batch of staging rows belongs
--   to that run." T06b's swap function reads `_ingestion_run_id` to know
--   which run produced the rows; runtime referential integrity comes from
--   the runner setting it correctly, not from the DB.
--   DO NOT add a REFERENCES clause to this column in a future migration.
--
-- C3 — TRUNCATE strategy assumes single-tenant
--   staging.irve_raw is shaped specifically for the IRVE consolidated CSV
--   and is wiped wholesale by every IRVE run. If a second source ever
--   needs staging (a new Etalab dataset, an operator's bulk publish), do
--   ONE OF the following — never reuse this table cross-source:
--     (a) Add a per-source staging table (staging.foo_raw).
--     (b) Refactor THIS table to soft-delete by adding a `_source_slug
--         text NOT NULL` column and replacing the TRUNCATE with a
--         DELETE FROM … WHERE _source_slug = …. Slower but multi-tenant.
--   Today (T06a) only `irve_consolidated` writes here. The single-tenant
--   assumption is loud-on-purpose so a future change is forced to choose.
--
-- COLUMN COUNT
--   The CSV header has 52 columns: 40 IRVE-spec v2.3.0 fields + 12
--   data.gouv consolidation extras (last_modified, datagouv_*, created_at,
--   consolidated_*). Phase 1 audit (docs/01-discovery.md §A.1) reported
--   "51 columns total = 41 spec + 10 extras"; the actual header at the
--   T06a authorship moment is 52 (40+12). The forward-practice JSONB
--   bucket `_extra_columns` absorbs any further drift without a migration.
--
-- WHY ALL COLUMNS TEXT
--   COPY into staging is forgiving by design. Type coercion (date, numeric,
--   boolean, geography) happens in T06b's swap function as it moves rows
--   to live.*. Bad data in staging is recoverable; bad data in live is not.

CREATE TABLE IF NOT EXISTS staging.irve_raw (
  -- IRVE v2.3.0 spec columns (40), in CSV header order
  nom_amenageur          text,
  siren_amenageur        text,
  contact_amenageur      text,
  nom_operateur          text,
  contact_operateur      text,
  telephone_operateur    text,
  nom_enseigne           text,
  id_station_itinerance  text,
  id_station_local       text,
  nom_station            text,
  implantation_station   text,
  adresse_station        text,
  code_insee_commune     text,
  "coordonneesXY"        text,
  nbre_pdc               text,
  id_pdc_itinerance      text,
  id_pdc_local           text,
  puissance_nominale     text,
  prise_type_ef          text,
  prise_type_2           text,
  prise_type_combo_ccs   text,
  prise_type_chademo     text,
  prise_type_autre       text,
  gratuit                text,
  paiement_acte          text,
  paiement_cb            text,
  paiement_autre         text,
  tarification           text,
  condition_acces        text,
  reservation            text,
  horaires               text,
  accessibilite_pmr      text,
  restriction_gabarit    text,
  station_deux_roues     text,
  raccordement           text,
  num_pdl                text,
  date_mise_en_service   text,
  observations           text,
  date_maj               text,
  cable_t2_attache       text,

  -- data.gouv consolidation extras (12), in CSV header order
  last_modified                          text,
  datagouv_dataset_id                    text,
  datagouv_resource_id                   text,
  datagouv_organization_or_owner         text,
  created_at                             text,
  consolidated_longitude                 text,
  consolidated_latitude                  text,
  consolidated_code_postal               text,
  consolidated_commune                   text,
  consolidated_is_lon_lat_correct        text,
  consolidated_is_code_insee_verified    text,
  consolidated_is_code_insee_modified    text,

  -- Drift bucket: any column not in the 52-column known set is captured
  -- here as a JSON object {column_name: text_value}. Forward practice on
  -- recurring drift: hand-author a follow-up migration to promote the
  -- column to a typed text column (in CSV header order) — never auto-
  -- promote from this bucket.
  _extra_columns         jsonb         NOT NULL DEFAULT '{}'::jsonb,

  -- Forensics: full original CSV line for the row, captured by the runner
  -- before the COPY. Lets us replay malformed rows by hand without
  -- re-downloading 150 MB.
  _raw_line              text,

  -- Logical link to the ingestion_runs row that produced these staging
  -- rows. NOT a foreign key — see C1 in this file's header.
  _ingestion_run_id      uuid          NOT NULL
);

-- Last-SHA cache, keyed by source slug. Lets the runner SHA-abort early
-- when the upstream CSV hasn't changed since the previous successful run.
-- Generic per-source by design (C2 from T06a brief): future sources get a
-- new row, not a new table.
CREATE TABLE IF NOT EXISTS staging.ingestion_run_meta (
  slug          text          PRIMARY KEY,
  last_sha      text          NOT NULL,
  last_run_at   timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ingestion_run_meta_slug_lowercase
    CHECK (slug = lower(slug) AND slug !~ '\s'),
  CONSTRAINT ingestion_run_meta_sha_format
    CHECK (last_sha ~ '^[0-9a-f]{64}$')
);

COMMENT ON TABLE staging.irve_raw IS
  'Per-run scratch landing for the IRVE consolidated CSV (T06a). TRUNCATEd at run start by the tools/irve-sync runner. All columns text + nullable except _ingestion_run_id (NOT NULL, no FK — see migration header C1). Single-tenant — see migration header C3.';

COMMENT ON COLUMN staging.irve_raw._extra_columns IS
  'JSONB bucket for CSV header columns the runner does not recognize from the v2.3.0 spec + data.gouv consolidation extras (52 known). Drift handler: hand-author a follow-up migration to promote recurring columns; never auto-promote.';

COMMENT ON COLUMN staging.irve_raw._raw_line IS
  'Verbatim CSV line for the row. Forensics for upstream parser regressions; lets us replay a single malformed row without re-downloading the 150 MB CSV.';

COMMENT ON COLUMN staging.irve_raw._ingestion_run_id IS
  'live.ingestion_runs.id of the run that produced these rows. NOT a foreign key — see migration 0011 header section C1 for the rationale (TRUNCATE incompatibility + staging/live schema isolation).';

COMMENT ON TABLE staging.ingestion_run_meta IS
  'SHA cache for early-abort on no-change. Keyed by live.sources.slug. T06a populates the irve_consolidated row; future sources add their own rows here.';
