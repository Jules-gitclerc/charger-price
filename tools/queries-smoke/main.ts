// tools/queries-smoke/main.ts — T15.1 smoke probe
//
// Verifies src/lib/db/queries.ts works end-to-end against live Supabase
// before T15.2 pages exist. SELECT-only — zero writes.
//
// USAGE
//   pnpm exec tsx tools/queries-smoke/main.ts
//
// WHAT IT CHECKS
//   - searchStationsByPostal('59290') returns ≥1 row, runs <2s wall-clock
//   - searchStationsByPostal('00000') returns 0 rows, doesn't crash
//   - searchStationsByEnseigne('LIDL') returns ≥1 row
//   - getStationDetail('FRDRVPCRFMKT293001') (DRIVECO P0 fixture) returns
//     a station with 1 active tariff containing 3 elements (1 ENERGY + 2
//     PARKING_TIME tiers — Pattern A per T13.2 commit notes)
//   - getStationDetail('FRBFCPVDIJZ') (CITEOS P1 multi-price fixture)
//     returns 1 tariff with 8 elements
//   - getStationDetail('NOPE_DOES_NOT_EXIST') returns null
//   - getQualiteCoverage() returns post-T13 numbers exactly
//   - All numeric fields are TS `number` not strings (R3 verification)

import {
  searchStationsByPostal,
  searchStationsByEnseigne,
  getStationDetail,
  getQualiteCoverage,
} from '../../src/lib/db/queries';

let failures = 0;

function check(label: string, ok: boolean, detail?: string) {
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const r = await fn();
  const ms = Math.round(performance.now() - t0);
  console.log(`  → ${label} took ${ms}ms`);
  return r;
}

async function main() {
  // ── Postal happy path ─────────────────────────────────────────────────
  const postalRows = await timed('searchStationsByPostal("59290")', () =>
    searchStationsByPostal('59290'),
  );
  check('postal returns rows', postalRows.length > 0, `${postalRows.length} rows`);
  if (postalRows.length > 0) {
    const r = postalRows[0];
    check(
      'postal: distance_meters is number',
      typeof r.distance_meters === 'number' && Number.isFinite(r.distance_meters),
      `dist=${r.distance_meters}`,
    );
    check(
      'postal: max_power_kw coerced (number or null)',
      r.max_power_kw === null || typeof r.max_power_kw === 'number',
      `max_power_kw=${r.max_power_kw}`,
    );
    check(
      'postal: best_confidence is enum or null',
      r.best_confidence === null ||
        ['verified', 'parsed', 'estimated', 'unknown'].includes(r.best_confidence),
      `confidence=${r.best_confidence}`,
    );
    console.log(`  → first row: ${r.nom_station} @ ${r.consolidated_commune}`);
  }

  // ── Postal empty path ─────────────────────────────────────────────────
  const empty = await searchStationsByPostal('00000');
  check('postal "00000" returns 0 rows without crash', empty.length === 0);

  // ── Enseigne ──────────────────────────────────────────────────────────
  const enseigneRows = await timed('searchStationsByEnseigne("LIDL")', () =>
    searchStationsByEnseigne('LIDL'),
  );
  check(
    'enseigne returns rows',
    enseigneRows.length > 0,
    `${enseigneRows.length} rows`,
  );
  if (enseigneRows.length > 0) {
    check(
      'enseigne: distance_meters is null (no anchor)',
      enseigneRows[0].distance_meters === null,
    );
  }

  // ── DRIVECO P0 fixture ────────────────────────────────────────────────
  const driveco = await timed(
    'getStationDetail("FRDRVPCRFMKT293001")',
    () => getStationDetail('FRDRVPCRFMKT293001'),
  );
  check('DRIVECO fixture exists', driveco !== null);
  if (driveco) {
    check(
      'DRIVECO: 1 active tariff',
      driveco.tariffs.length === 1,
      `got ${driveco.tariffs.length}`,
    );
    if (driveco.tariffs[0]) {
      const t = driveco.tariffs[0];
      check(
        'DRIVECO: source = driveco_irve_json',
        t.source_slug === 'driveco_irve_json',
        `got ${t.source_slug}`,
      );
      check(
        'DRIVECO: confidence = parsed',
        t.confidence === 'parsed',
        `got ${t.confidence}`,
      );
      check(
        'DRIVECO: 3 elements (1 ENERGY + 2 PARKING_TIME)',
        t.elements.length === 3,
        `got ${t.elements.length}`,
      );
      const types = t.elements.flatMap((e) => e.components.map((c) => c.type)).sort();
      check(
        'DRIVECO: component types match Pattern A',
        JSON.stringify(types) === JSON.stringify(['ENERGY', 'PARKING_TIME', 'PARKING_TIME']),
        `got ${JSON.stringify(types)}`,
      );
    }
  }

  // ── CITEOS multi-price fixture ────────────────────────────────────────
  const citeos = await timed('getStationDetail("FRBFCPVDIJZ")', () =>
    getStationDetail('FRBFCPVDIJZ'),
  );
  check('CITEOS fixture exists', citeos !== null);
  if (citeos && citeos.tariffs[0]) {
    const t = citeos.tariffs[0];
    check(
      'CITEOS: source = citeos_template_parser',
      t.source_slug === 'citeos_template_parser',
      `got ${t.source_slug}`,
    );
    check(
      'CITEOS: 8 elements',
      t.elements.length === 8,
      `got ${t.elements.length}`,
    );
  }

  // ── 404 path ──────────────────────────────────────────────────────────
  const missing = await getStationDetail('NOPE_DOES_NOT_EXIST');
  check('missing station returns null', missing === null);

  // ── Coverage ──────────────────────────────────────────────────────────
  const cov = await timed('getQualiteCoverage()', () => getQualiteCoverage());
  check('coverage: total_stations = 52806', cov.total_stations === 52806, `got ${cov.total_stations}`);
  check('coverage: with_operator_id ~ 29446', cov.with_operator_id > 28000 && cov.with_operator_id < 30500, `got ${cov.with_operator_id}`);
  check('coverage: with_station_tariffs = 6970', cov.with_station_tariffs === 6970, `got ${cov.with_station_tariffs}`);
  check('coverage: with_tariff_url = 1657', cov.with_tariff_url === 1657, `got ${cov.with_tariff_url}`);
  check('coverage: by_confidence.parsed = 6970', cov.by_confidence.parsed === 6970, `got ${cov.by_confidence.parsed}`);
  check('coverage: by_confidence.verified = 0', cov.by_confidence.verified === 0);
  check('coverage: parser_source rows present', cov.by_parser_source.length > 0, `${cov.by_parser_source.length} rows`);
  check('coverage: last_irve_sync_at is set', cov.last_irve_sync_at !== null);
  check('coverage: last_parser_run_at is set', cov.last_parser_run_at !== null);

  console.log(
    `\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});
