-- Migration 0015 — IRVE PDC dedupe at target grain
--
-- T06b, M1 W3. Corrective for 0014's first-apply station undercount
-- (45,527 stations landed vs 52,816 distinct in raw staging — 7,289
-- silently dropped by cross-station id_pdc_itinerance collisions).
--
-- Brief references:
--   T06a brief design call A — 3-function shape (unchanged)
--   T06b brief hard rules:
--     #3  no writes to live.station_tariffs (still binding)
--     #4  single-transaction swap; failure ROLLBACK leaves live untouched
--         (caught four bugs this session: two via ROLLBACK before write,
--         two via post-commit math-band guards before commit-to-git)
--     #5  soft-delete only — last_seen_in_irve_at; no DELETE in M1
--
-- Architecture references (unchanged from 0012/0013/0014):
--   docs/02-architecture.md §1.2 — entity rationale
--   docs/02-architecture.md §2.4 — Layer 1 step 6: diff-and-swap
--
-- Supersedes 0012 → 0013 → 0014's valid_pdcs filter / dedupe placement —
-- see E17, E18, E19, E20 in docs/migrations-errata.md (bundled at end of
-- T06b).
--
-- WHY HAND-ROLLED SQL: Drizzle Kit doesn't generate function bodies.
--
-- IDEMPOTENCY: CREATE OR REPLACE FUNCTION. Re-applying is a no-op.
--
-- SCOPE — two functions touched.
--   Single-function pattern (0013, 0014) was a heuristic for surgical
--   patches, not a hard rule. This fix genuinely spans two functions.
--   The alternative (keeping dedupe at valid_pdcs + projecting a
--   "winning station") is exactly the kind of clever-but-wrong fix that
--   creates compound complexity. Move PDC-grain dedupe to where it
--   semantically belongs (charge_points UPSERT site, mirroring how
--   upsert_stations_from_staging already DISTINCT ONs at id_station
--   grain), and accept the 2-function diff.
--
--   live.run_irve_swap                  — valid_pdcs becomes a pure
--                                          validity filter (no DISTINCT
--                                          ON, no ORDER BY).
--   live.upsert_charge_points_from_staging
--                                       — wraps the source SELECT in a
--                                          DISTINCT ON (id_pdc_itinerance)
--                                          CTE with the same tiebreak
--                                          previously at valid_pdcs level.
--
--   live.upsert_stations_from_staging — UNCHANGED. Already correct.
--   live.coerce_irve_coordinates      — UNCHANGED.
--   live.close_ingestion_run          — UNCHANGED.
--
-- DESIGN CALL (single, narrow):
--
-- D1 — Move PDC-grain dedupe from validity filter to target-table UPSERT.
--   The validity filter's job is "is this row eligible for ingestion?"
--   — a per-row predicate. Dedupe is "which row wins for a given PK
--   conflict target?" — a per-conflict-target decision. Conflating them
--   forces dedupe at the wrong grain whenever the conflict-target ID
--   isn't globally unique (E20 — IRVE id_pdc_itinerance is not globally
--   unique: 13.0% of 155,830 distinct PDC IDs appear at multiple
--   distinct id_station_itinerance, max 3 stations per PDC ID). The fix
--   puts the dedupe at the conflict-target's UPSERT site —
--   live.charge_points.id_pdc_itinerance is the PK conflict target, so
--   DISTINCT ON happens inside upsert_charge_points_from_staging,
--   mirroring how upsert_stations_from_staging already DISTINCT ONs at
--   id_station_itinerance for live.stations's PK.
--
--   Same tiebreak as 0014 (date_maj DESC NULLS LAST, id_station_itinerance
--   ASC) — deterministic and identical winner selection across calls.
--
--   Stations whose PDCs lose the cross-station tiebreak still land in
--   live.stations via upsert_stations_from_staging. Those stations may
--   have 0 PDCs in live.charge_points — schema tolerates this; no
--   constraint requires >= 1 PDC per station. That's E20's empirical
--   "orphan stations" property of the system.
--
-- No new functions. No new tables. No schema changes. Pure body fix.

-- ─────────────────────────────────────────────────────────────────────────
-- Orchestrator — valid_pdcs becomes a pure validity filter
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
  -- 0015: pure validity filter, no DISTINCT ON, no ORDER BY.
  CREATE TEMP TABLE valid_pdcs ON COMMIT DROP AS
  SELECT *
  FROM staging.irve_raw
  WHERE _ingestion_run_id = p_run_id
    AND live.coerce_irve_coordinates("coordonneesXY") IS NOT NULL
    AND puissance_nominale ~ '^\s*[0-9]+([.,][0-9]+)?\s*$'
    AND replace(btrim(puissance_nominale), ',', '.')::numeric(7,2) > 0
    AND nullif(btrim(id_station_itinerance), '') IS NOT NULL
    AND nullif(btrim(id_pdc_itinerance), '')     IS NOT NULL
    AND nullif(btrim(nom_station), '')           IS NOT NULL
    AND id_pdc_itinerance     !~ '\s'
    AND id_station_itinerance !~ '\s';

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

v4 (0015-corrective): valid_pdcs is now a pure validity filter (no DISTINCT ON, no ORDER BY). PDC-grain dedupe moved to inside upsert_charge_points_from_staging, where it semantically belongs (the dedupe target == the UPSERT's conflict target). 0014's first apply succeeded on charge_points but undercounted stations by 7,289 because the DISTINCT ON (id_pdc_itinerance) at valid_pdcs level collapsed cross-station as well as within-station — IRVE id_pdc_itinerance is not globally unique (E20: 13.0% of distinct PDC IDs appear at multiple stations, max 3). 0015 is the corrective.

Destination column type assumptions (E19 application note — listed explicitly so future maintainers can audit):
  live.charge_points.power_kw   numeric(7,2) NOT NULL, CHECK > 0  → filter casts to numeric(7,2) and checks > 0
  live.charge_points.id_pdc_itinerance text NOT NULL PK         → filter requires non-whitespace; DISTINCT ON in upsert_charge_points (target-grain dedupe per E20)
  live.charge_points.station_id text NOT NULL FK→live.stations  → satisfied because upsert_stations runs first against the same valid_pdcs and inserts ALL distinct stations (even those whose PDCs lose the cross-station tiebreak)
  live.stations.id_station_itinerance text NOT NULL PK          → filter requires non-whitespace + (in upsert_stations) DISTINCT ON
  live.stations.nom_station text NOT NULL                       → filter requires non-empty after btrim
  live.stations.geom geography(Point, 4326) NOT NULL            → filter requires coerce_irve_coordinates IS NOT NULL
  live.stations.consolidated_code_postal CHECK (~ '^[0-9]{5}$' OR NULL) → src CTE: regex-gated CASE WHEN, NULL on non-conformant
  live.stations.date_maj date, date_mise_en_service date        → src CTE: regex-gated CASE WHEN, NULL on non-ISO; date-validity audit (T06b.1) confirmed all regex-matching values cast cleanly
  live.ingestion_runs.status terminal ⇔ finished_at NOT NULL (0007 D1 CHECK) → close_ingestion_run sets both atomically$cmt$;

-- ─────────────────────────────────────────────────────────────────────────
-- charge_points UPSERT — adds DISTINCT ON id_pdc_itinerance at target grain
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
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema LIKE 'pg_temp%' AND table_name = 'valid_pdcs'
  ) THEN
    RAISE EXCEPTION 'pg_temp.valid_pdcs not present — call live.upsert_charge_points_from_staging via live.run_irve_swap, not directly';
  END IF;

  SELECT count(*) INTO v_seen
  FROM staging.irve_raw
  WHERE _ingestion_run_id = p_run_id;

  WITH src AS (
    SELECT DISTINCT ON (id_pdc_itinerance) *
    FROM pg_temp.valid_pdcs
    ORDER BY id_pdc_itinerance,
             nullif(btrim(date_maj), '') DESC NULLS LAST,
             id_station_itinerance ASC
  ),
  upserted AS (
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
    FROM src v
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
  $cmt$Per-PDC UPSERT to live.charge_points from pg_temp.valid_pdcs (built by live.run_irve_swap). Bumps last_seen_in_irve_at to now() for new and existing rows; rows not in this batch retain their previous last_seen_in_irve_at (D9, soft-delete only). RAISES if called outside live.run_irve_swap (D2 contract). Returns charge-point-grain counts.

v2 (0015): Source SELECT wrapped in a DISTINCT ON (id_pdc_itinerance) CTE with ORDER BY id_pdc_itinerance, nullif(btrim(date_maj),'') DESC NULLS LAST, id_station_itinerance ASC tiebreak. Dedupes at the target table's PK grain (id_pdc_itinerance is live.charge_points's conflict target). Same tiebreak philosophy as upsert_stations_from_staging's DISTINCT ON (D8 of 0012). Stations whose PDCs lose the cross-station tiebreak still land in live.stations via upsert_stations_from_staging — they may have 0 PDCs in live.charge_points (schema tolerates this; no constraint requires >= 1 PDC per station). PDC-grain dedupe was previously at valid_pdcs level in 0013–0014; that placement collapsed across stations because IRVE id_pdc_itinerance is not globally unique (E20 — 13.0% of distinct PDC IDs at multiple stations).$cmt$;
