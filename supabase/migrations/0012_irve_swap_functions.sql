-- Migration 0012 — IRVE swap functions
--
-- T06b, M1 W3. Closes the IRVE ingestion spine started in T06a (0011).
--
-- Brief references:
--   T06a brief design call A — 3-function shape:
--     live.upsert_stations_from_staging
--     live.upsert_charge_points_from_staging
--     live.run_irve_swap   (orchestrator)
--   T06b brief hard rules:
--     #3  no writes to live.station_tariffs (T13/scrapers own it)
--     #4  single-transaction swap; failure ROLLBACK leaves live untouched
--     #5  soft-delete only — last_seen_in_irve_at; no DELETE in M1
--
-- Architecture references:
--   docs/02-architecture.md §1.2 — entity rationale
--   docs/02-architecture.md §2.4 — Layer 1 step 6: "diff-and-swap, not
--                                  truncate-and-reload"
--
-- WHY HAND-ROLLED SQL: Drizzle Kit doesn't generate function bodies; the
-- diff-and-swap is pure SQL plumbing without ORM benefit.
--
-- IDEMPOTENCY: every CREATE FUNCTION uses CREATE OR REPLACE. Re-applying
-- the migration is a no-op against an unchanged source.
--
-- DESIGN CALLS (reflecting the T06b.1 review round):
--
-- D1 — valid_pdcs as a TEMP TABLE, ON COMMIT DROP.
--   Built once by run_irve_swap; both upsert_* helpers SELECT from it.
--   ON COMMIT DROP aligns with the "swap is atomic" semantics — the
--   temp table vanishes when the caller's txn ends (commit OR rollback).
--
-- D2 — Orchestrator-only contract, RAISE EXCEPTION on missing temp table.
--   Both upsert_* helpers RAISE if pg_temp.valid_pdcs is absent. Trust-
--   the-orchestrator guardrail, not a security boundary. Path (a) per
--   the T06b.1 C3 round.
--
-- D3 — run_irve_swap runs in caller-provided txn; no internal
--   BEGIN/COMMIT/SAVEPOINT, no EXCEPTION block. Errors propagate to the
--   caller, which must ROLLBACK and call close_ingestion_run separately.
--   Matches forward errata E15.
--
-- D4 — The stranded T06a 'running' ingestion_runs row closes implicitly
--   when run_irve_swap is called with that run's uuid. The function
--   operates strictly on staging rows tagged with the matching
--   _ingestion_run_id and updates only live.ingestion_runs.id = p_run_id.
--
-- D5 — Boolean coercion inline (no helper). IRVE booleans appear as
--   'true'/'false'/'TRUE'/'FALSE'/'1'/'0'/'oui'/'non'/empty.
--   CASE on lower(nullif(btrim(x), '')); NULL on unrecognized.
--
-- D6 — paiement_*/gratuit/reservation/etc. are nullable on live.* —
--   NULL-on-unrecognized is fine, no skip.
--
-- D7 — puissance_nominale validity at the valid_pdcs filter.
--   Empty / non-numeric / zero / negative → row excluded → counted to
--   rows_skipped. Belt-and-suspenders with the live.charge_points
--   power_kw > 0 CHECK. Handles ',' or '.' decimal separator.
--
-- D8 — DISTINCT ON tie-break: ORDER BY id_station_itinerance,
--   nullif(btrim(date_maj),'') DESC NULLS LAST, id_pdc_itinerance ASC.
--   Picks the freshest PDC's station fields when sibling PDCs disagree.
--   IRVE date format is ISO YYYY-MM-DD so lexicographic = chronological.
--
-- D9 — Soft-delete is implicit. New rows get last_seen_in_irve_at=now();
--   existing rows in batch get last_seen_in_irve_at=now() via ON CONFLICT
--   DO UPDATE; rows not in batch retain their previous last_seen_in_irve_at.
--   No explicit "WHERE NOT IN (staging) UPDATE" anywhere in this file.
--
-- D10 — coerce_irve_coordinates is STABLE, not IMMUTABLE.
--   Sufficient for our use (no expression indexes on coordinate-derived
--   fields); STABLE avoids Postgres's volatility-classification edge
--   cases around regex / locale.
--
-- jsonb shape returned by run_irve_swap (Q1 of T06b.1):
--   { status, rows_seen, rows_inserted, rows_updated, rows_skipped,
--     stations_inserted, stations_updated, stations_skipped,
--     error_message, duration_ms }
--   rows_* are charge-point-grain (the C3 contract); stations_* are
--   derived station-grain, redundant for log readability.
--
-- partial-vs-success threshold (Q2 of T06b.1):
--   Binary on cp.rows_skipped. > 0 ⇒ 'partial'. == 0 ⇒ 'success'.
--   No ratio gate — application/dashboard layer can apply one if needed.
--
-- Forward errata bundled at end of T06b: E13 (psql command-tag stripping
-- invariant), E14 (migration-numbering off-by-one — Phase-3 said 0011 for
-- swap, reality 0012), E15 (failure-path closure must be a separate
-- post-rollback statement), E16 (soft-delete is the only delete in M1),
-- plus application-note expansions on E10 (pooler-vs-direct connection)
-- and E11 (211,708-row baseline as of T06a real run).

-- ─────────────────────────────────────────────────────────────────────────
-- Helper #1 — coordinate coercion
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION live.coerce_irve_coordinates(p_raw text)
RETURNS geography(Point, 4326)
LANGUAGE sql STABLE
AS $$
  WITH parsed AS (
    SELECT m[1]::float8 AS lon, m[2]::float8 AS lat
    FROM regexp_match(
      btrim(p_raw),
      '^\[?\s*(-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)\s*,\s*(-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)\s*\]?$'
    ) AS m
    WHERE m IS NOT NULL
  )
  SELECT CASE
    WHEN lon BETWEEN -180 AND 180 AND lat BETWEEN -90 AND 90
    THEN ST_SetSRID(ST_MakePoint(lon, lat), 4326)::geography
    ELSE NULL
  END
  FROM parsed;
$$;

COMMENT ON FUNCTION live.coerce_irve_coordinates(text) IS
  'Parses IRVE coordonneesXY text into a PostGIS geography(Point, 4326). Handles shape 1 ([lon, lat]) and shape 2 (bare ''lon,lat'') with native float8 cast for scientific notation. Range-validates lon in [-180, 180], lat in [-90, 90]. Returns NULL on any parse / range failure. STABLE per T06b.1 design call (no expression-index need; STABLE avoids regex / locale volatility-classification edge cases).';

-- ─────────────────────────────────────────────────────────────────────────
-- Helper #2 — ingestion_runs row closure
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION live.close_ingestion_run(
  p_run_id  uuid,
  p_status  text,
  p_counts  jsonb,
  p_error   text
)
RETURNS void
LANGUAGE sql
AS $$
  UPDATE live.ingestion_runs
  SET status        = p_status,
      finished_at   = now(),
      rows_seen     = (p_counts->>'rows_seen')::int,
      rows_inserted = (p_counts->>'rows_inserted')::int,
      rows_updated  = (p_counts->>'rows_updated')::int,
      rows_skipped  = (p_counts->>'rows_skipped')::int,
      error_message = nullif(p_error, '')
  WHERE id = p_run_id;
$$;

COMMENT ON FUNCTION live.close_ingestion_run(uuid, text, jsonb, text) IS
  'Single-statement closure of a live.ingestion_runs row. Used by run_irve_swap on the success / partial path AND by the runner on the post-rollback failure path (E15 forward practice — the failure-path call is a separate post-rollback statement, not part of the rolled-back txn). Honors the 0007 D1 state-machine CHECK: setting status to a terminal value implies finished_at IS NOT NULL. Re-closure of an already-terminal row overwrites silently — idempotent by design.';

-- ─────────────────────────────────────────────────────────────────────────
-- charge_points UPSERT
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION live.upsert_charge_points_from_staging(p_run_id uuid)
RETURNS table(rows_seen int, rows_inserted int, rows_updated int, rows_skipped int)
LANGUAGE plpgsql
AS $$
DECLARE
  v_seen int;
  v_ins  int := 0;
  v_upd  int := 0;
BEGIN
  -- D2 contract: pg_temp.valid_pdcs must exist (built by run_irve_swap).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema LIKE 'pg_temp%' AND table_name = 'valid_pdcs'
  ) THEN
    RAISE EXCEPTION 'pg_temp.valid_pdcs not present — call live.upsert_charge_points_from_staging via live.run_irve_swap, not directly';
  END IF;

  -- Charge-point-grain rows_seen: raw count of staging rows for this run.
  SELECT count(*) INTO v_seen
  FROM staging.irve_raw
  WHERE _ingestion_run_id = p_run_id;

  WITH upserted AS (
    INSERT INTO live.charge_points (
      id_pdc_itinerance, station_id, id_pdc_local, power_kw,
      cable_t2_attache,
      prise_type_ef, prise_type_2, prise_type_combo_ccs,
      prise_type_chademo, prise_type_autre,
      paiement_acte, paiement_cb, paiement_autre, gratuit,
      observations,
      last_seen_in_irve_at, first_seen_at
    )
    SELECT
      v.id_pdc_itinerance,
      v.id_station_itinerance,
      nullif(btrim(v.id_pdc_local), ''),
      replace(btrim(v.puissance_nominale), ',', '.')::numeric,
      CASE lower(nullif(btrim(v.cable_t2_attache), ''))
        WHEN 'true' THEN true WHEN '1' THEN true WHEN 'oui' THEN true
        WHEN 'false' THEN false WHEN '0' THEN false WHEN 'non' THEN false
        ELSE NULL END,
      CASE lower(nullif(btrim(v.prise_type_ef), ''))
        WHEN 'true' THEN true WHEN '1' THEN true WHEN 'oui' THEN true
        WHEN 'false' THEN false WHEN '0' THEN false WHEN 'non' THEN false
        ELSE NULL END,
      CASE lower(nullif(btrim(v.prise_type_2), ''))
        WHEN 'true' THEN true WHEN '1' THEN true WHEN 'oui' THEN true
        WHEN 'false' THEN false WHEN '0' THEN false WHEN 'non' THEN false
        ELSE NULL END,
      CASE lower(nullif(btrim(v.prise_type_combo_ccs), ''))
        WHEN 'true' THEN true WHEN '1' THEN true WHEN 'oui' THEN true
        WHEN 'false' THEN false WHEN '0' THEN false WHEN 'non' THEN false
        ELSE NULL END,
      CASE lower(nullif(btrim(v.prise_type_chademo), ''))
        WHEN 'true' THEN true WHEN '1' THEN true WHEN 'oui' THEN true
        WHEN 'false' THEN false WHEN '0' THEN false WHEN 'non' THEN false
        ELSE NULL END,
      CASE lower(nullif(btrim(v.prise_type_autre), ''))
        WHEN 'true' THEN true WHEN '1' THEN true WHEN 'oui' THEN true
        WHEN 'false' THEN false WHEN '0' THEN false WHEN 'non' THEN false
        ELSE NULL END,
      CASE lower(nullif(btrim(v.paiement_acte), ''))
        WHEN 'true' THEN true WHEN '1' THEN true WHEN 'oui' THEN true
        WHEN 'false' THEN false WHEN '0' THEN false WHEN 'non' THEN false
        ELSE NULL END,
      CASE lower(nullif(btrim(v.paiement_cb), ''))
        WHEN 'true' THEN true WHEN '1' THEN true WHEN 'oui' THEN true
        WHEN 'false' THEN false WHEN '0' THEN false WHEN 'non' THEN false
        ELSE NULL END,
      CASE lower(nullif(btrim(v.paiement_autre), ''))
        WHEN 'true' THEN true WHEN '1' THEN true WHEN 'oui' THEN true
        WHEN 'false' THEN false WHEN '0' THEN false WHEN 'non' THEN false
        ELSE NULL END,
      CASE lower(nullif(btrim(v.gratuit), ''))
        WHEN 'true' THEN true WHEN '1' THEN true WHEN 'oui' THEN true
        WHEN 'false' THEN false WHEN '0' THEN false WHEN 'non' THEN false
        ELSE NULL END,
      nullif(btrim(v.observations), ''),
      now(),
      now()
    FROM pg_temp.valid_pdcs v
    ON CONFLICT (id_pdc_itinerance) DO UPDATE SET
      station_id           = EXCLUDED.station_id,
      id_pdc_local         = EXCLUDED.id_pdc_local,
      power_kw             = EXCLUDED.power_kw,
      cable_t2_attache     = EXCLUDED.cable_t2_attache,
      prise_type_ef        = EXCLUDED.prise_type_ef,
      prise_type_2         = EXCLUDED.prise_type_2,
      prise_type_combo_ccs = EXCLUDED.prise_type_combo_ccs,
      prise_type_chademo   = EXCLUDED.prise_type_chademo,
      prise_type_autre     = EXCLUDED.prise_type_autre,
      paiement_acte        = EXCLUDED.paiement_acte,
      paiement_cb          = EXCLUDED.paiement_cb,
      paiement_autre       = EXCLUDED.paiement_autre,
      gratuit              = EXCLUDED.gratuit,
      observations         = EXCLUDED.observations,
      last_seen_in_irve_at = now()
      -- updated_at handled by 0002's set_updated_at trigger
    RETURNING (xmax = 0) AS is_insert
  )
  SELECT
    count(*) FILTER (WHERE is_insert),
    count(*) FILTER (WHERE NOT is_insert)
  INTO v_ins, v_upd
  FROM upserted;

  rows_seen     := v_seen;
  rows_inserted := v_ins;
  rows_updated  := v_upd;
  rows_skipped  := v_seen - (v_ins + v_upd);
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION live.upsert_charge_points_from_staging(uuid) IS
  'Per-PDC UPSERT to live.charge_points from pg_temp.valid_pdcs (built by live.run_irve_swap). Bumps last_seen_in_irve_at to now() for new and existing rows; rows not in this batch retain their previous last_seen_in_irve_at (D9, soft-delete only). RAISES if called outside live.run_irve_swap (D2 contract). Returns charge-point-grain counts.';

-- ─────────────────────────────────────────────────────────────────────────
-- stations UPSERT
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION live.upsert_stations_from_staging(p_run_id uuid)
RETURNS table(rows_seen int, rows_inserted int, rows_updated int, rows_skipped int)
LANGUAGE plpgsql
AS $$
DECLARE
  v_seen int;
  v_ins  int := 0;
  v_upd  int := 0;
BEGIN
  -- D2 contract: pg_temp.valid_pdcs must exist (built by run_irve_swap).
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema LIKE 'pg_temp%' AND table_name = 'valid_pdcs'
  ) THEN
    RAISE EXCEPTION 'pg_temp.valid_pdcs not present — call live.upsert_stations_from_staging via live.run_irve_swap, not directly';
  END IF;

  -- Station-grain rows_seen: distinct id_station_itinerance in raw staging
  -- for this run. rows_skipped = stations whose every PDC failed validity.
  SELECT count(DISTINCT id_station_itinerance) INTO v_seen
  FROM staging.irve_raw
  WHERE _ingestion_run_id = p_run_id
    AND nullif(btrim(id_station_itinerance), '') IS NOT NULL;

  WITH src AS (
    SELECT DISTINCT ON (v.id_station_itinerance)
      v.id_station_itinerance,
      nullif(btrim(v.id_station_local), '')                        AS id_station_local,
      v.nom_station,
      nullif(btrim(v.nom_enseigne), '')                            AS nom_enseigne,
      nullif(btrim(v.adresse_station), '')                         AS adresse_station,
      nullif(btrim(v.code_insee_commune), '')                      AS code_insee_commune,
      CASE WHEN v.consolidated_code_postal ~ '^[0-9]{5}$'
           THEN v.consolidated_code_postal ELSE NULL END           AS consolidated_code_postal,
      nullif(btrim(v.consolidated_commune), '')                    AS consolidated_commune,
      live.coerce_irve_coordinates(v."coordonneesXY")              AS geom,
      nullif(btrim(v.implantation_station), '')                    AS implantation_station,
      nullif(btrim(v.condition_acces), '')                         AS condition_acces,
      nullif(btrim(v.horaires), '')                                AS horaires,
      CASE lower(nullif(btrim(v.reservation), ''))
        WHEN 'true' THEN true WHEN '1' THEN true WHEN 'oui' THEN true
        WHEN 'false' THEN false WHEN '0' THEN false WHEN 'non' THEN false
        ELSE NULL END                                              AS reservation,
      nullif(btrim(v.accessibilite_pmr), '')                       AS accessibilite_pmr,
      nullif(btrim(v.restriction_gabarit), '')                     AS restriction_gabarit,
      CASE lower(nullif(btrim(v.station_deux_roues), ''))
        WHEN 'true' THEN true WHEN '1' THEN true WHEN 'oui' THEN true
        WHEN 'false' THEN false WHEN '0' THEN false WHEN 'non' THEN false
        ELSE NULL END                                              AS station_deux_roues,
      nullif(btrim(v.raccordement), '')                            AS raccordement,
      nullif(btrim(v.num_pdl), '')                                 AS num_pdl,
      CASE WHEN v.date_mise_en_service ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
           THEN v.date_mise_en_service::date ELSE NULL END         AS date_mise_en_service,
      nullif(btrim(v.observations), '')                            AS observations,
      CASE WHEN v.date_maj ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
           THEN v.date_maj::date ELSE NULL END                     AS date_maj
    FROM pg_temp.valid_pdcs v
    WHERE nullif(btrim(v.nom_station), '') IS NOT NULL
    ORDER BY v.id_station_itinerance,
             nullif(btrim(v.date_maj), '') DESC NULLS LAST,
             v.id_pdc_itinerance ASC
  ),
  upserted AS (
    INSERT INTO live.stations (
      id_station_itinerance,
      id_station_local, nom_station, nom_enseigne,
      adresse_station, code_insee_commune,
      consolidated_code_postal, consolidated_commune,
      geom,
      implantation_station, condition_acces, horaires, reservation,
      accessibilite_pmr, restriction_gabarit, station_deux_roues,
      raccordement, num_pdl, date_mise_en_service, observations,
      date_maj,
      last_seen_in_irve_at, first_seen_at
    )
    SELECT
      s.id_station_itinerance,
      s.id_station_local, s.nom_station, s.nom_enseigne,
      s.adresse_station, s.code_insee_commune,
      s.consolidated_code_postal, s.consolidated_commune,
      s.geom,
      s.implantation_station, s.condition_acces, s.horaires, s.reservation,
      s.accessibilite_pmr, s.restriction_gabarit, s.station_deux_roues,
      s.raccordement, s.num_pdl, s.date_mise_en_service, s.observations,
      s.date_maj,
      now(), now()
    FROM src s
    ON CONFLICT (id_station_itinerance) DO UPDATE SET
      id_station_local         = EXCLUDED.id_station_local,
      nom_station              = EXCLUDED.nom_station,
      nom_enseigne             = EXCLUDED.nom_enseigne,
      adresse_station          = EXCLUDED.adresse_station,
      code_insee_commune       = EXCLUDED.code_insee_commune,
      consolidated_code_postal = EXCLUDED.consolidated_code_postal,
      consolidated_commune     = EXCLUDED.consolidated_commune,
      geom                     = EXCLUDED.geom,
      implantation_station     = EXCLUDED.implantation_station,
      condition_acces          = EXCLUDED.condition_acces,
      horaires                 = EXCLUDED.horaires,
      reservation              = EXCLUDED.reservation,
      accessibilite_pmr        = EXCLUDED.accessibilite_pmr,
      restriction_gabarit      = EXCLUDED.restriction_gabarit,
      station_deux_roues       = EXCLUDED.station_deux_roues,
      raccordement             = EXCLUDED.raccordement,
      num_pdl                  = EXCLUDED.num_pdl,
      date_mise_en_service     = EXCLUDED.date_mise_en_service,
      observations             = EXCLUDED.observations,
      date_maj                 = EXCLUDED.date_maj,
      last_seen_in_irve_at     = now()
      -- updated_at handled by 0002's set_updated_at trigger
      -- operator_id / network_id NOT touched here — T08 owns those
    RETURNING (xmax = 0) AS is_insert
  )
  SELECT
    count(*) FILTER (WHERE is_insert),
    count(*) FILTER (WHERE NOT is_insert)
  INTO v_ins, v_upd
  FROM upserted;

  rows_seen     := v_seen;
  rows_inserted := v_ins;
  rows_updated  := v_upd;
  rows_skipped  := v_seen - (v_ins + v_upd);
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION live.upsert_stations_from_staging(uuid) IS
  'Station-grain UPSERT to live.stations from pg_temp.valid_pdcs (built by live.run_irve_swap). DISTINCT ON (id_station_itinerance) selects one staging row per station, tied by date_maj DESC NULLS LAST then id_pdc_itinerance ASC (D8). Bumps last_seen_in_irve_at to now() for new and existing rows; rows not in this batch retain their previous last_seen_in_irve_at (D9, soft-delete only). Does NOT touch operator_id / network_id (T08 owns those). RAISES if called outside live.run_irve_swap (D2 contract). Returns station-grain counts: rows_seen = distinct stations in raw staging; rows_skipped = stations whose every PDC failed validity.';

-- ─────────────────────────────────────────────────────────────────────────
-- Orchestrator
-- ─────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION live.run_irve_swap(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  t_start      timestamptz := clock_timestamp();
  s            record;
  cp           record;
  result       jsonb;
  final_status text;
BEGIN
  -- D1: build pg_temp.valid_pdcs once, ON COMMIT DROP. Vanishes when the
  -- caller's txn ends (commit OR rollback).
  CREATE TEMP TABLE valid_pdcs ON COMMIT DROP AS
  SELECT *
  FROM staging.irve_raw
  WHERE _ingestion_run_id = p_run_id
    AND live.coerce_irve_coordinates("coordonneesXY") IS NOT NULL
    AND puissance_nominale ~ '^\s*[0-9]+([.,][0-9]+)?\s*$'
    AND replace(btrim(puissance_nominale), ',', '.')::numeric > 0
    AND nullif(btrim(id_station_itinerance), '') IS NOT NULL
    AND nullif(btrim(id_pdc_itinerance), '')     IS NOT NULL
    AND nullif(btrim(nom_station), '')           IS NOT NULL;

  SELECT * INTO s  FROM live.upsert_stations_from_staging(p_run_id);
  SELECT * INTO cp FROM live.upsert_charge_points_from_staging(p_run_id);

  -- Q2: binary threshold on charge-point-grain skip count.
  final_status := CASE WHEN cp.rows_skipped > 0 THEN 'partial' ELSE 'success' END;

  result := jsonb_build_object(
    'status',            final_status,
    'rows_seen',         cp.rows_seen,
    'rows_inserted',     cp.rows_inserted,
    'rows_updated',      cp.rows_updated,
    'rows_skipped',      cp.rows_skipped,
    'stations_inserted', s.rows_inserted,
    'stations_updated',  s.rows_updated,
    'stations_skipped',  s.rows_skipped,
    'error_message',     NULL,
    'duration_ms',       (extract(epoch from clock_timestamp() - t_start) * 1000)::int
  );

  PERFORM live.close_ingestion_run(p_run_id, final_status, result, NULL);

  RETURN result;
END;
$$;

COMMENT ON FUNCTION live.run_irve_swap(uuid) IS
  $cmt$IRVE diff-and-swap orchestrator. Builds pg_temp.valid_pdcs (ON COMMIT DROP), calls upsert_stations_from_staging + upsert_charge_points_from_staging, closes the live.ingestion_runs row via close_ingestion_run.

Runs in caller-provided txn — no internal BEGIN/COMMIT/SAVEPOINT, no EXCEPTION block. On error, the caller must ROLLBACK the txn and call live.close_ingestion_run(p_run_id, 'failed', ..., error_message) as a separate post-rollback statement (E15 forward practice).

Returns jsonb of shape:
  {
    "status":             'success' | 'partial' | 'failed',
    "rows_seen":          int,    -- charge-point grain (== count of staging rows for this run)
    "rows_inserted":      int,    -- charge-point grain
    "rows_updated":       int,    -- charge-point grain
    "rows_skipped":       int,    -- charge-point grain (== rows_seen - (inserted + updated))
    "stations_inserted":  int,    -- station-grain (DISTINCT id_station_itinerance from valid_pdcs)
    "stations_updated":   int,    -- station-grain
    "stations_skipped":   int,    -- station-grain (stations whose every PDC failed the validity filter)
    "error_message":      text | null,
    "duration_ms":        int
  }
The rows_* fields are charge-point-grain (the C3 contract); stations_* are derived station-grain, redundant for log readability.

Status semantics (D2 of 0007 + Q2 of 0012):
  'success' iff rows_skipped == 0
  'partial' iff rows_skipped > 0 AND no fatal exception was raised
  'failed'  never set by this function; runner sets it via close_ingestion_run after rolling back the swap txn (E15).
The threshold is binary by design: any non-zero skip count surfaces 'partial' so the freshness dashboard can see it. Application/dashboard code may apply a ratio threshold (e.g. rows_skipped / rows_seen) to decide if 'partial' is noise or anomaly. Don't gate it inside the function.$cmt$;
