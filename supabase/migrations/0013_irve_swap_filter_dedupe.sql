-- Migration 0013 — IRVE swap filter + DISTINCT ON dedupe
--
-- T06b, M1 W3. Corrective for 0012's first-apply SQLSTATE 21000 failure
-- ("ON CONFLICT DO UPDATE command cannot affect row a second time").
--
-- Brief references:
--   T06a brief design call A — 3-function shape (unchanged)
--   T06b brief hard rules:
--     #3  no writes to live.station_tariffs (still binding)
--     #4  single-transaction swap; failure ROLLBACK leaves live untouched
--         (rolled back successfully on 0012's first apply — proof of contract)
--     #5  soft-delete only — last_seen_in_irve_at; no DELETE in M1
--
-- Architecture references (unchanged from 0012):
--   docs/02-architecture.md §1.2 — entity rationale
--   docs/02-architecture.md §2.4 — Layer 1 step 6: "diff-and-swap, not
--                                  truncate-and-reload"
--
-- Supersedes 0012's valid_pdcs filter — see E17 + E18 in
-- docs/migrations-errata.md (bundled at end of T06b).
--
-- WHY HAND-ROLLED SQL: Drizzle Kit doesn't generate function bodies.
--
-- IDEMPOTENCY: CREATE OR REPLACE FUNCTION. Re-applying is a no-op.
--
-- SCOPE — single function touched.
--   Only live.run_irve_swap(uuid) is re-emitted. The other 4 functions
--   from 0012 (live.coerce_irve_coordinates, live.close_ingestion_run,
--   live.upsert_stations_from_staging, live.upsert_charge_points_from_staging)
--   are NOT re-emitted — bug was localized to the orchestrator's
--   valid_pdcs filter, no need to touch unchanged bodies. Smaller diff,
--   clearer audit trail.
--
-- DESIGN CALLS (corrective, narrow):
--
-- D1 — Whitespace-only sentinel filter on both IRVE national IDs.
--   The valid_pdcs build adds:
--     AND id_pdc_itinerance     !~ '\s'
--     AND id_station_itinerance !~ '\s'
--   Empirical staging analysis (Q2 + Q4 of T06b.1 review round) found
--   119 PDC rows with id_pdc_itinerance = 'Non concerné' and 1,158
--   station rows with whitespace-bearing id_station_itinerance. Among
--   non-FR-prefix PDC IDs, 'Non concerné' is the only count > 1 — every
--   other non-FR-prefix value is unique-once (382 BE/AT/other-format
--   legitimate operator IDs). So whitespace-only is the minimum filter
--   that resolves the SQLSTATE 21000 root cause without rejecting
--   legitimate non-French operator rows (E18, geography-agnostic by
--   design at the swap layer).
--
-- D2 — DISTINCT ON id_pdc_itinerance dedupe with date_maj tiebreak.
--   Replaces SELECT * with SELECT DISTINCT ON (id_pdc_itinerance) *.
--   ORDER BY id_pdc_itinerance,
--            nullif(btrim(date_maj), '') DESC NULLS LAST,
--            id_station_itinerance ASC
--   Collapses ~55,877 PDC-level operator-side duplicates (E17 — 26.4%
--   row-count overshoot in IRVE consolidated). Same tie-break philosophy
--   as the upsert_stations_from_staging DISTINCT ON in 0012 (D8):
--   freshest-row-wins on date_maj, deterministic last-resort on
--   id_station_itinerance ASC.
--
-- No new functions. No new tables. No schema changes. Pure body fix.

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
  -- D1 + D2: whitespace-only sentinel filter on both IDs, plus
  -- DISTINCT ON id_pdc_itinerance with date_maj tiebreak.
  CREATE TEMP TABLE valid_pdcs ON COMMIT DROP AS
  SELECT DISTINCT ON (id_pdc_itinerance) *
  FROM staging.irve_raw
  WHERE _ingestion_run_id = p_run_id
    AND live.coerce_irve_coordinates("coordonneesXY") IS NOT NULL
    AND puissance_nominale ~ '^\s*[0-9]+([.,][0-9]+)?\s*$'
    AND replace(btrim(puissance_nominale), ',', '.')::numeric > 0
    AND nullif(btrim(id_station_itinerance), '') IS NOT NULL
    AND nullif(btrim(id_pdc_itinerance), '')     IS NOT NULL
    AND nullif(btrim(nom_station), '')           IS NOT NULL
    AND id_pdc_itinerance     !~ '\s'
    AND id_station_itinerance !~ '\s'
  ORDER BY id_pdc_itinerance,
           nullif(btrim(date_maj), '') DESC NULLS LAST,
           id_station_itinerance ASC;

  SELECT * INTO s  FROM live.upsert_stations_from_staging(p_run_id);
  SELECT * INTO cp FROM live.upsert_charge_points_from_staging(p_run_id);

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
The threshold is binary by design: any non-zero skip count surfaces 'partial' so the freshness dashboard can see it. Application/dashboard code may apply a ratio threshold (e.g. rows_skipped / rows_seen) to decide if 'partial' is noise or anomaly. Don't gate it inside the function.

v2 (0013-corrective): valid_pdcs filter now rejects whitespace-bearing IRVE national IDs (E17 sentinel placeholders, e.g. 'Non concerné') on both id_pdc_itinerance and id_station_itinerance, and dedupes on id_pdc_itinerance via DISTINCT ON with ORDER BY id_pdc_itinerance, nullif(btrim(date_maj),'') DESC NULLS LAST, id_station_itinerance ASC tiebreak. Geography-agnostic — non-French operator rows (E18 — BE DRIVECO, AT HTB) pass through. 0012's first apply failed with SQLSTATE 21000 on first invocation; 0013 is the corrective.$cmt$;
