// Read-only queries for the M1 internal viewer (T15, W5).
//
// SCOPE: SELECT-only against live.* — no INSERT/UPDATE/DELETE, no migrations,
// no swap-function changes. Powers /internal/search, /internal/station/[id],
// /internal/qualite-des-donnees (T15.2).
//
// HYBRID ORM STRATEGY (DC-T15-A): Drizzle's `sql` template is used for query
// composition (parameter binding + escaping); `db.execute<T>(sql\`...\`)`
// returns rows typed by the caller. PostGIS operations (ST_*, KNN `<->`) and
// the active-row tariff-best-confidence subquery require raw SQL fragments;
// the rest is straight SELECT shape. Numerics arrive from postgres-js as JS
// strings; this module is the boundary that coerces them to `number` so
// page components never touch the string→number transition (R3).
//
// TWO-QUERY POSTAL PATTERN (errata candidate E24): live.stations.
// consolidated_code_postal lacks a btree index post-T07 population. A
// single-query CTE form (`WITH center AS (SELECT AVG(ST_X(geom::geometry))
// ...) SELECT ... FROM stations CROSS JOIN center ORDER BY geom <-> ...`)
// forces a full Seq Scan over 52,806 rows because the AVG aggregate
// materializes the entire postal-filter set — measured 2,022 ms (over the
// 2 s M1 budget). The two-query workaround (a) early-stop LIMIT 1 postal
// lookup ≈30 ms, then (b) KNN with literal coords ≈150 ms ≈180 ms server-
// side total. Hard rule W5 #8 ("no new indexes for M1") preserved. M1.5
// removal trigger: add btree index on consolidated_code_postal once viewer
// search patterns stabilize, then collapse to single CTE query.

import { sql } from 'drizzle-orm';

import { dbReadOnly as db } from './index';

// ─── Public types (post-coercion shapes) ────────────────────────────────

export type Confidence = 'verified' | 'parsed' | 'estimated' | 'unknown';

/** One row in /internal/search results table. */
export type StationSearchResult = {
  id_station_itinerance: string;
  nom_station: string;
  nom_enseigne: string | null;
  operator_display_name: string | null;
  consolidated_code_postal: string | null;
  consolidated_commune: string | null;
  adresse_station: string | null;
  /** Max power across the station's PDCs, kW. NULL if no PDCs. */
  max_power_kw: number | null;
  /** Distance from the search anchor in meters. NULL for enseigne searches. */
  distance_meters: number | null;
  /** Best (lowest enum-priority) active confidence at this station. */
  best_confidence: Confidence | null;
  /** Has a non-null tariff_url even when no parsed tariff. UX fallback. */
  has_tariff_url: boolean;
};

export type TariffElementDetail = {
  element_id: string;
  sequence_number: number;
  components: Array<{
    type: 'ENERGY' | 'TIME' | 'FLAT' | 'PARKING_TIME';
    price: number;
    vat: number | null;
    step_size: number;
  }>;
  restriction: {
    start_time: string | null;
    end_time: string | null;
    min_duration: number | null;
    max_duration: number | null;
    min_power: number | null;
    max_power: number | null;
    day_of_week: string[] | null;
  } | null;
};

export type StationTariffDetail = {
  station_tariff_id: string;
  tariff_id: string | null;
  tariff_slug: string | null;
  tariff_display_name: string | null;
  tariff_type: string | null;
  payment_method_slug: string;
  payment_method_display_name: string;
  confidence: Confidence;
  source_slug: string;
  source_display_name: string;
  parser_version: string | null;
  last_verified_at: string;
  elements: TariffElementDetail[];
};

export type StationDetail = {
  id_station_itinerance: string;
  nom_station: string;
  nom_enseigne: string | null;
  operator_display_name: string | null;
  adresse_station: string | null;
  consolidated_code_postal: string | null;
  consolidated_commune: string | null;
  tariff_url: string | null;
  /** Max power across the station's PDCs, kW. */
  max_power_kw: number | null;
  /** Total PDC count at this station. */
  pdc_count: number;
  tariffs: StationTariffDetail[];
};

export type CoverageStats = {
  total_stations: number;
  with_operator_id: number;
  with_postal_code: number;
  with_station_tariffs: number;
  with_tariff_url: number;
  by_confidence: Record<Confidence, number>;
  by_parser_source: Array<{ source_slug: string; outcome: string; count: number }>;
  last_irve_sync_at: string | null;
  last_parser_run_at: string | null;
};

// ─── Internal helpers ───────────────────────────────────────────────────

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const numOr = (v: unknown, fallback: number): number =>
  v == null ? fallback : Number(v);

/** Confidence enum-priority order for "best of" picking (lower wins). */
const CONFIDENCE_PRIORITY = sql.raw(
  "CASE confidence WHEN 'verified' THEN 0 WHEN 'parsed' THEN 1 WHEN 'estimated' THEN 2 ELSE 3 END",
);

// ─── Search ─────────────────────────────────────────────────────────────

/**
 * KNN nearest-10 stations from a (lng, lat) anchor. Uses the GIST index on
 * live.stations.geom via the `<->` distance operator (≈150 ms measured).
 */
async function nearestStations(
  lng: number,
  lat: number,
  limit = 10,
): Promise<StationSearchResult[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT
      s.id_station_itinerance,
      s.nom_station,
      s.nom_enseigne,
      s.consolidated_code_postal,
      s.consolidated_commune,
      s.adresse_station,
      o.display_name AS operator_display_name,
      (s.tariff_url IS NOT NULL) AS has_tariff_url,
      ST_Distance(s.geom, ST_MakePoint(${lng}, ${lat})::geography) AS distance_meters,
      (
        SELECT MAX(cp.power_kw)
          FROM live.charge_points cp
         WHERE cp.station_id = s.id_station_itinerance
      ) AS max_power_kw,
      (
        SELECT confidence
          FROM live.station_tariffs st
         WHERE st.station_id = s.id_station_itinerance
           AND st.valid_to IS NULL
         ORDER BY ${CONFIDENCE_PRIORITY}
         LIMIT 1
      ) AS best_confidence
    FROM live.stations s
    LEFT JOIN live.operators o ON o.id = s.operator_id
    ORDER BY s.geom <-> ST_MakePoint(${lng}, ${lat})::geography
    LIMIT ${limit}
  `);

  return rows.map(mapSearchRow);
}

function mapSearchRow(r: Record<string, unknown>): StationSearchResult {
  return {
    id_station_itinerance: r.id_station_itinerance as string,
    nom_station: r.nom_station as string,
    nom_enseigne: (r.nom_enseigne as string | null) ?? null,
    operator_display_name: (r.operator_display_name as string | null) ?? null,
    consolidated_code_postal:
      (r.consolidated_code_postal as string | null) ?? null,
    consolidated_commune: (r.consolidated_commune as string | null) ?? null,
    adresse_station: (r.adresse_station as string | null) ?? null,
    max_power_kw: num(r.max_power_kw),
    distance_meters: num(r.distance_meters),
    best_confidence: (r.best_confidence as Confidence | null) ?? null,
    has_tariff_url: r.has_tariff_url === true,
  };
}

/**
 * Search by 5-digit postal code. Two-query pattern (E24 workaround).
 * Returns up to 10 nearest stations from the postal centroid.
 * Empty array if postal has no stations.
 */
export async function searchStationsByPostal(
  postal: string,
): Promise<StationSearchResult[]> {
  // Step 1: anchor lookup. Early-stop LIMIT 1 ≈30 ms.
  const centerRows = await db.execute<{ lng: unknown; lat: unknown }>(sql`
    SELECT
      ST_X(geom::geometry) AS lng,
      ST_Y(geom::geometry) AS lat
      FROM live.stations
     WHERE consolidated_code_postal = ${postal}
     LIMIT 1
  `);
  if (centerRows.length === 0) return [];

  // Step 2: KNN with literal coords. ≈150 ms.
  const lng = numOr(centerRows[0].lng, 0);
  const lat = numOr(centerRows[0].lat, 0);
  return nearestStations(lng, lat, 10);
}

/**
 * Search by enseigne text (case-insensitive substring match against
 * live.stations.nom_enseigne). No distance, returns up to 10 matches by
 * nom_station ASC. Limit kept small for M1 viewer; broader search is M1.5.
 */
export async function searchStationsByEnseigne(
  query: string,
): Promise<StationSearchResult[]> {
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT
      s.id_station_itinerance,
      s.nom_station,
      s.nom_enseigne,
      s.consolidated_code_postal,
      s.consolidated_commune,
      s.adresse_station,
      o.display_name AS operator_display_name,
      (s.tariff_url IS NOT NULL) AS has_tariff_url,
      NULL::float AS distance_meters,
      (
        SELECT MAX(cp.power_kw)
          FROM live.charge_points cp
         WHERE cp.station_id = s.id_station_itinerance
      ) AS max_power_kw,
      (
        SELECT confidence
          FROM live.station_tariffs st
         WHERE st.station_id = s.id_station_itinerance
           AND st.valid_to IS NULL
         ORDER BY ${CONFIDENCE_PRIORITY}
         LIMIT 1
      ) AS best_confidence
    FROM live.stations s
    LEFT JOIN live.operators o ON o.id = s.operator_id
    WHERE s.nom_enseigne ILIKE ${'%' + query + '%'}
    ORDER BY s.nom_station ASC
    LIMIT 10
  `);
  return rows.map(mapSearchRow);
}

// ─── Station detail ─────────────────────────────────────────────────────

/**
 * Full detail page payload for one station. Returns null if id unknown.
 * Loads station + operator + active station_tariffs + tariff elements +
 * components + restrictions in 3 round-trips (1 head + 1 tariff list +
 * 1 element/component/restriction batch). Acceptable for an internal
 * viewer; M1.5 may collapse to a single JSON-aggregated query.
 */
export async function getStationDetail(
  id: string,
): Promise<StationDetail | null> {
  const headRows = await db.execute<Record<string, unknown>>(sql`
    SELECT
      s.id_station_itinerance,
      s.nom_station,
      s.nom_enseigne,
      s.adresse_station,
      s.consolidated_code_postal,
      s.consolidated_commune,
      s.tariff_url,
      o.display_name AS operator_display_name,
      (
        SELECT MAX(cp.power_kw)
          FROM live.charge_points cp
         WHERE cp.station_id = s.id_station_itinerance
      ) AS max_power_kw,
      (
        SELECT COUNT(*)::int
          FROM live.charge_points cp
         WHERE cp.station_id = s.id_station_itinerance
      ) AS pdc_count
    FROM live.stations s
    LEFT JOIN live.operators o ON o.id = s.operator_id
    WHERE s.id_station_itinerance = ${id}
  `);
  if (headRows.length === 0) return null;
  const h = headRows[0];

  const tariffRows = await db.execute<Record<string, unknown>>(sql`
    SELECT
      st.id AS station_tariff_id,
      st.tariff_id,
      st.confidence,
      st.parser_version,
      st.last_verified_at,
      pm.slug AS payment_method_slug,
      pm.display_name AS payment_method_display_name,
      src.slug AS source_slug,
      src.display_name AS source_display_name,
      t.slug AS tariff_slug,
      t.display_name AS tariff_display_name,
      t.tariff_type
    FROM live.station_tariffs st
    JOIN live.payment_methods pm ON pm.id = st.payment_method_id
    JOIN live.sources src ON src.id = st.source_id
    LEFT JOIN live.tariffs t ON t.id = st.tariff_id
    WHERE st.station_id = ${id}
      AND st.valid_to IS NULL
    ORDER BY ${CONFIDENCE_PRIORITY}, pm.slug
  `);

  const tariffIds = tariffRows
    .map((r) => r.tariff_id as string | null)
    .filter((v): v is string => v != null);

  const elementRows = tariffIds.length
    ? await db.execute<Record<string, unknown>>(sql`
        SELECT
          te.id AS element_id,
          te.tariff_id,
          te.sequence_number,
          pc.type AS component_type,
          pc.price AS component_price,
          pc.vat AS component_vat,
          pc.step_size AS component_step_size,
          tr.start_time,
          tr.end_time,
          tr.min_duration,
          tr.max_duration,
          tr.min_power,
          tr.max_power,
          tr.day_of_week
        FROM live.tariff_elements te
        JOIN live.price_components pc ON pc.tariff_element_id = te.id
        LEFT JOIN live.tariff_restrictions tr ON tr.tariff_element_id = te.id
        WHERE te.tariff_id IN ${sql`(${sql.join(
          tariffIds.map((tid) => sql`${tid}`),
          sql.raw(','),
        )})`}
        ORDER BY te.tariff_id, te.sequence_number, pc.type
      `)
    : [];

  return {
    id_station_itinerance: h.id_station_itinerance as string,
    nom_station: h.nom_station as string,
    nom_enseigne: (h.nom_enseigne as string | null) ?? null,
    operator_display_name: (h.operator_display_name as string | null) ?? null,
    adresse_station: (h.adresse_station as string | null) ?? null,
    consolidated_code_postal:
      (h.consolidated_code_postal as string | null) ?? null,
    consolidated_commune: (h.consolidated_commune as string | null) ?? null,
    tariff_url: (h.tariff_url as string | null) ?? null,
    max_power_kw: num(h.max_power_kw),
    pdc_count: numOr(h.pdc_count, 0),
    tariffs: tariffRows.map((tr) => ({
      station_tariff_id: tr.station_tariff_id as string,
      tariff_id: (tr.tariff_id as string | null) ?? null,
      tariff_slug: (tr.tariff_slug as string | null) ?? null,
      tariff_display_name: (tr.tariff_display_name as string | null) ?? null,
      tariff_type: (tr.tariff_type as string | null) ?? null,
      payment_method_slug: tr.payment_method_slug as string,
      payment_method_display_name: tr.payment_method_display_name as string,
      confidence: tr.confidence as Confidence,
      source_slug: tr.source_slug as string,
      source_display_name: tr.source_display_name as string,
      parser_version: (tr.parser_version as string | null) ?? null,
      last_verified_at: tr.last_verified_at as string,
      elements: foldElements(elementRows, tr.tariff_id as string | null),
    })),
  };
}

/** Group component+restriction rows back into TariffElementDetail shape. */
function foldElements(
  rows: Record<string, unknown>[],
  tariffId: string | null,
): TariffElementDetail[] {
  if (!tariffId) return [];
  const byElement = new Map<string, TariffElementDetail>();
  for (const r of rows) {
    if (r.tariff_id !== tariffId) continue;
    const eid = r.element_id as string;
    let el = byElement.get(eid);
    if (!el) {
      el = {
        element_id: eid,
        sequence_number: numOr(r.sequence_number, 0),
        components: [],
        restriction:
          r.start_time != null ||
          r.end_time != null ||
          r.min_duration != null ||
          r.max_duration != null ||
          r.min_power != null ||
          r.max_power != null ||
          r.day_of_week != null
            ? {
                start_time: (r.start_time as string | null) ?? null,
                end_time: (r.end_time as string | null) ?? null,
                min_duration: num(r.min_duration),
                max_duration: num(r.max_duration),
                min_power: num(r.min_power),
                max_power: num(r.max_power),
                day_of_week: (r.day_of_week as string[] | null) ?? null,
              }
            : null,
      };
      byElement.set(eid, el);
    }
    el.components.push({
      type: r.component_type as TariffElementDetail['components'][number]['type'],
      price: numOr(r.component_price, 0),
      vat: num(r.component_vat),
      step_size: numOr(r.component_step_size, 1),
    });
  }
  return Array.from(byElement.values()).sort(
    (a, b) => a.sequence_number - b.sequence_number,
  );
}

// ─── Coverage / qualité-des-données ─────────────────────────────────────

/**
 * Aggregations for /internal/qualite-des-donnees. One round-trip per
 * aggregate to keep each query plan trivial; total runtime well under 1s
 * on M1 data shapes.
 */
export async function getQualiteCoverage(): Promise<CoverageStats> {
  const stationCounts = await db.execute<Record<string, unknown>>(sql`
    SELECT
      COUNT(*)::int AS total_stations,
      COUNT(operator_id)::int AS with_operator_id,
      COUNT(consolidated_code_postal)::int AS with_postal_code,
      COUNT(tariff_url)::int AS with_tariff_url
    FROM live.stations
  `);

  const tariffCount = await db.execute<{ count: unknown }>(sql`
    SELECT COUNT(DISTINCT station_id)::int AS count
      FROM live.station_tariffs
     WHERE valid_to IS NULL
  `);

  const confidenceRows = await db.execute<{
    confidence: unknown;
    count: unknown;
  }>(sql`
    SELECT confidence, COUNT(*)::int AS count
      FROM live.station_tariffs
     WHERE valid_to IS NULL
     GROUP BY confidence
  `);

  const parserRows = await db.execute<{
    source_slug: unknown;
    outcome: unknown;
    count: unknown;
  }>(sql`
    SELECT src.slug AS source_slug, po.outcome, COUNT(*)::int AS count
      FROM live.parser_outcomes po
      JOIN live.sources src ON src.id = po.source_id
     GROUP BY src.slug, po.outcome
     ORDER BY count DESC
  `);

  const lastIrve = await db.execute<{ finished_at: unknown }>(sql`
    SELECT finished_at
      FROM live.ingestion_runs ir
      JOIN live.sources src ON src.id = ir.source_id
     WHERE src.slug = 'irve_consolidated'
       AND ir.status = 'success'
     ORDER BY finished_at DESC NULLS LAST
     LIMIT 1
  `);

  const lastParser = await db.execute<{ finished_at: unknown }>(sql`
    SELECT finished_at
      FROM live.ingestion_runs ir
      JOIN live.sources src ON src.id = ir.source_id
     WHERE src.slug = 'parser_orchestrator'
       AND ir.status = 'success'
     ORDER BY finished_at DESC NULLS LAST
     LIMIT 1
  `);

  const sc = stationCounts[0];
  const byConfidence: Record<Confidence, number> = {
    verified: 0,
    parsed: 0,
    estimated: 0,
    unknown: 0,
  };
  for (const row of confidenceRows) {
    const k = row.confidence as Confidence;
    if (k in byConfidence) byConfidence[k] = numOr(row.count, 0);
  }

  return {
    total_stations: numOr(sc.total_stations, 0),
    with_operator_id: numOr(sc.with_operator_id, 0),
    with_postal_code: numOr(sc.with_postal_code, 0),
    with_tariff_url: numOr(sc.with_tariff_url, 0),
    with_station_tariffs: numOr(tariffCount[0].count, 0),
    by_confidence: byConfidence,
    by_parser_source: parserRows.map((r) => ({
      source_slug: r.source_slug as string,
      outcome: r.outcome as string,
      count: numOr(r.count, 0),
    })),
    last_irve_sync_at: (lastIrve[0]?.finished_at as string | null) ?? null,
    last_parser_run_at: (lastParser[0]?.finished_at as string | null) ?? null,
  };
}
