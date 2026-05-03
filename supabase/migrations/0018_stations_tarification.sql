-- Migration 0018 — live.stations.tarification + copy function
--
-- T13.0, M1 W5.
--
-- WHY THIS MIGRATION
--   The W5 parser pipeline (T13 orchestrator P5→P0→P1→P2→P3) needs a
--   live source for the IRVE `tarification` text field. Two prior
--   constraints make this non-trivial:
--     (1) live.stations does not currently carry tarification — T06's
--         upsert_stations_from_staging deliberately omits free-text
--         columns it doesn't structure.
--     (2) staging.irve_raw is truncated post-swap-success per E21
--         forward-practice (a) (avoid disk-full ~150 MB residue
--         between syncs).
--   Net: the parser orchestrator has no live source to read from
--   between IRVE syncs.
--
--   §0 Option C resolution (per T13 design summary): add a nullable
--   tarification column to live.stations, plus a new SQL function
--   `live.copy_tarification_from_staging()` called by the irve-sync
--   runner BETWEEN run_irve_swap() and TRUNCATE staging.irve_raw.
--   T06's 5 swap functions remain immutable per W5 hard rule #8.
--   The new function is additive — does not modify the existing
--   swap path.
--
-- CANONICAL-ROW STRATEGY (audit-blind-spot pattern instance #10)
--   T13 pre-flight surfaced 3,052 of 14,151 content-bearing stations
--   (21.6%) carry ≥2 distinct tarification values across their PDCs
--   (real example: FR3R3P89882136 has '0,36€/kWh' AND '0,55€/kWh',
--   likely AC vs DC connectors). PDC-grain Phase-1 numbers do not
--   predict station-grain reality (E22-class lesson).
--
--   Same dedupe pattern as T06b's PDC-grain (E20):
--   `DISTINCT ON (id_station_itinerance) ORDER BY date_maj DESC NULLS LAST`.
--   Picks the most-recently-updated tarification per station. Stations
--   with all-NULL/empty tarification across PDCs leave their
--   live.stations.tarification unchanged (i.e. NULL on first apply).
--
-- IDEMPOTENCY
--   ALTER ... ADD COLUMN IF NOT EXISTS — safe re-apply.
--   CREATE OR REPLACE FUNCTION — safe re-apply.
--   The function itself is idempotent: re-running picks the
--   currently-most-recent value, overwriting any previous copy.
--
-- E17 FORMAT GATE
--   The function inherits the same id_station_itinerance format
--   regex from T06b's swap functions (positive-match `^FR[A-Z0-9]`).
--   Sentinel placeholders like 'Non concerné' that leaked through
--   IRVE rows pre-T06 (E17) are filtered out at the SELECT site.
--
-- DEPENDENCIES
--   - 0002 (live.stations table)
--   - 0011 (staging.irve_raw schema with tarification + date_maj)
--   - 0012-0015 (T06 swap functions — NOT modified by this migration)
--
-- CALLED FROM
--   tools/irve-sync/main.py (T13.0 amendment): inserted between the
--   swap success verification (~line 699) and _truncate_staging
--   (~line 708). If the function call fails, the runner aborts before
--   truncating staging — preserves data for forensics.

-- ─────────────────────────────────────────────────────────────────────────
-- live.stations.tarification column
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE live.stations
  ADD COLUMN IF NOT EXISTS tarification text;

COMMENT ON COLUMN live.stations.tarification IS
  'IRVE tarification free-text field, copied from staging.irve_raw post-swap by live.copy_tarification_from_staging() (T13.0). Source for the parser pipeline (P5/P0/P1/P2/P3 in tools/run-parsers/, T13.2). Canonical row per station picked via DISTINCT ON (id_station_itinerance) ORDER BY date_maj DESC NULLS LAST when multiple PDCs share a station with conflicting tarification (~21.6% of content-bearing stations per T13 pre-flight). Nullable: stations with all-NULL/empty tarification across PDCs remain NULL.';

-- ─────────────────────────────────────────────────────────────────────────
-- live.copy_tarification_from_staging()
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION live.copy_tarification_from_staging()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  affected integer;
BEGIN
  UPDATE live.stations s
     SET tarification = sub.tarification
    FROM (
      SELECT DISTINCT ON (id_station_itinerance)
        id_station_itinerance,
        tarification
      FROM staging.irve_raw
      WHERE tarification IS NOT NULL
        AND btrim(tarification) != ''
        AND id_station_itinerance ~ '^FR[A-Z0-9]'
      ORDER BY id_station_itinerance, date_maj DESC NULLS LAST
    ) sub
   WHERE s.id_station_itinerance = sub.id_station_itinerance;
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

COMMENT ON FUNCTION live.copy_tarification_from_staging() IS
  'Copies tarification from staging.irve_raw to live.stations after T06 swap, before T07.0''s post-swap TRUNCATE. Uses DISTINCT ON (id_station_itinerance) ORDER BY date_maj DESC NULLS LAST to pick canonical row when multiple PDCs share a station with conflicting tarification (21.6% of content-bearing stations per T13 pre-flight). Returns count of stations updated. Idempotent. Called by tools/irve-sync/main.py between run_irve_swap() and TRUNCATE staging.irve_raw. T06''s 5 swap functions remain immutable per W5 hard rule #8.';
