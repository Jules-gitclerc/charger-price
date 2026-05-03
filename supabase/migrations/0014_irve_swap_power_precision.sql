-- Migration 0014 — IRVE swap power precision
--
-- T06b, M1 W3. Corrective for 0013's first-apply SQLSTATE 23514 failure
-- ("new row for relation charge_points violates check constraint
-- charge_points_power_positive"). Single staging row had
-- puissance_nominale='0.0001' which passed 0013's plain-numeric > 0
-- filter but rounded to 0.00 at numeric(7,2) on insert into
-- live.charge_points.power_kw.
--
-- Brief references:
--   T06a brief design call A — 3-function shape (unchanged)
--   T06b brief hard rules:
--     #3  no writes to live.station_tariffs (still binding)
--     #4  single-transaction swap; failure ROLLBACK leaves live untouched
--         (ROLLBACK held cleanly on 0013's first apply — second proof of
--         the contract this session)
--     #5  soft-delete only — last_seen_in_irve_at; no DELETE in M1
--
-- Architecture references (unchanged from 0012/0013):
--   docs/02-architecture.md §1.2 — entity rationale
--   docs/02-architecture.md §2.4 — Layer 1 step 6: diff-and-swap
--
-- Supersedes 0012's then 0013's valid_pdcs filter — see E17, E18, E19 in
-- docs/migrations-errata.md (bundled at end of T06b).
--
-- WHY HAND-ROLLED SQL: Drizzle Kit doesn't generate function bodies.
--
-- IDEMPOTENCY: CREATE OR REPLACE FUNCTION. Re-applying is a no-op.
--
-- SCOPE — single function touched.
--   Only live.run_irve_swap(uuid) is re-emitted. Same surgical pattern
--   as 0013. The other 4 functions from 0012 stay unchanged.
--
-- DESIGN CALL (single, narrow):
--
-- D1 — Match destination column precision in the validity filter.
--   Change `replace(...)::numeric > 0` to `replace(...)::numeric(7,2) > 0`.
--   live.charge_points.power_kw is numeric(7,2) with CHECK > 0; the
--   filter now reflects both. Rejects 1 staging row
--   (FRPD1EEPSSTGALF22011, puissance_nominale='0.0001'). Real chargers
--   are >= 3 kW domestic, 22 kW AC, 50–350 kW DC; 0.0001 kW is data
--   garbage that passed 0013's unbounded-numeric filter.
--
-- DATE / POSTAL CODE AUDIT (T06b.1, recorded for paper trail):
--   Concurrent with 0014 drafting, audited the existing regex-gated
--   CASE-WHEN casts in upsert_stations_from_staging's src CTE for
--   round-trip safety. All four checks returned empty:
--     - 0 date_maj rows match `^[0-9]{4}-[0-9]{2}-[0-9]{2}$` but fail
--       the strict `^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$`
--     - 0 date_mise_en_service rows fail the same strict-form check
--     - DO-block-trapped cast attempts on both date columns completed
--       without raising for any regex-matching row
--     - 0 consolidated_code_postal rows are non-empty + non-`^[0-9]{5}$`
--   Conclusion: existing regex-gated casts are sufficient. No date or
--   postal stricter-regex extension needed in 0014.
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
  CREATE TEMP TABLE valid_pdcs ON COMMIT DROP AS
  SELECT DISTINCT ON (id_pdc_itinerance) *
  FROM staging.irve_raw
  WHERE _ingestion_run_id = p_run_id
    AND live.coerce_irve_coordinates("coordonneesXY") IS NOT NULL
    AND puissance_nominale ~ '^\s*[0-9]+([.,][0-9]+)?\s*$'
    AND replace(btrim(puissance_nominale), ',', '.')::numeric(7,2) > 0
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

v2 (0013-corrective): valid_pdcs filter now rejects whitespace-bearing IRVE national IDs (E17 sentinel placeholders, e.g. 'Non concerné') on both id_pdc_itinerance and id_station_itinerance, and dedupes on id_pdc_itinerance via DISTINCT ON with ORDER BY id_pdc_itinerance, nullif(btrim(date_maj),'') DESC NULLS LAST, id_station_itinerance ASC tiebreak. Geography-agnostic — non-French operator rows (E18 — BE DRIVECO, AT HTB) pass through. 0012's first apply failed with SQLSTATE 21000 on first invocation; 0013 is the corrective.

v3 (0014-corrective): valid_pdcs filter now casts puissance_nominale through the destination column's precision (numeric(7,2)) before the > 0 check, matching live.charge_points.power_kw exactly. 0013's first apply failed with SQLSTATE 23514 (CHECK power_kw > 0) on a staging row with puissance_nominale='0.0001' (rounds to 0.00 at numeric(7,2)). 0014 is the corrective.

Destination column type assumptions (E19 application note — listed explicitly so future maintainers can audit):
  live.charge_points.power_kw   numeric(7,2) NOT NULL, CHECK > 0  → filter casts to numeric(7,2) and checks > 0
  live.charge_points.id_pdc_itinerance text NOT NULL PK         → filter requires non-whitespace + DISTINCT ON
  live.charge_points.station_id text NOT NULL FK→live.stations  → satisfied because upsert_stations runs first against the same valid_pdcs
  live.stations.id_station_itinerance text NOT NULL PK          → filter requires non-whitespace + (in upsert_stations) DISTINCT ON
  live.stations.nom_station text NOT NULL                       → filter requires non-empty after btrim
  live.stations.geom geography(Point, 4326) NOT NULL            → filter requires coerce_irve_coordinates IS NOT NULL
  live.stations.consolidated_code_postal CHECK (~ '^[0-9]{5}$' OR NULL) → src CTE: regex-gated CASE WHEN, NULL on non-conformant
  live.stations.date_maj date, date_mise_en_service date        → src CTE: regex-gated CASE WHEN, NULL on non-ISO; date-validity audit (T06b.1) confirmed all regex-matching values cast cleanly
  live.ingestion_runs.status terminal ⇔ finished_at NOT NULL (0007 D1 CHECK) → close_ingestion_run sets both atomically$cmt$;
