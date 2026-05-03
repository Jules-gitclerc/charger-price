// P2 regex €/kWh parser smoke runner — diagnostic only.
//
// Reads .cache/irve.csv, applies parseRegexKwh to every row, reports:
//   - success / rejected breakdown
//   - per-clause occurrence histogram across all extracted elements
//   - per-unit subset (€ vs integer-cts vs decimal-cts ambiguity)
//   - per-enseigne distribution (top 15)
//   - centimes interpretation note count
//   - decimal-cts ambiguity warning count
//   - subscription marker count
//   - prefix context count
//   - multi-clause input count
//   - false-positive guards against P5 + P0 + P1 + P3 territory (4 guards)
//
// NO database access. NO writes. Exits non-zero on regression.
//
// Run:
//   pnpm exec tsx tools/parsers-smoke/regex-kwh.ts
//   pnpm exec tsx tools/parsers-smoke/regex-kwh.ts --csv path/to/other.csv
//
// Exit codes:
//   0   smoke passed
//   1   regression (recovery < 99% of attempted, decimal-cts != 32 ±5,
//       hallmark+0-clauses > 100, OR FP > 0)
//   2   environmental fault

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  parseRegexKwh,
  type RegexKwhSourceClause,
} from '../../src/lib/parsers/regex-kwh';
import { detectSentinel } from '../../src/lib/parsers/sentinel';
import { parseCiteosTemplate } from '../../src/lib/parsers/citeos-template';

// Anchored against T12 pre-flight (.cache/irve.csv 2026-05-02):
//   11,611 broad-hallmark rows.
//   Decimal-cts input rows: 21 (T12 design summary said 32 — incorrect;
//   verified 21 via post-flight probe). All 21 are sole-clause decimal-cts
//   rows that reject (no other extractable clauses).
//   Acceptance: ≥99% recovery, decimal-cts inputs = 21 (±5), 0 FP,
//   hallmark+0 < 100.
const EXPECTED_HALLMARK = 11_611;
const EXPECTED_FLOOR = Math.floor(EXPECTED_HALLMARK * 0.99);
const DECIMAL_CTS_BASELINE = 21;
const DECIMAL_CTS_TOLERANCE = 5;
const HALLMARK_NOCLAUSE_CEILING = 100;

// Probe-based detection of decimal-cts input rows. Counts regardless
// of parser outcome — sole-clause decimal-cts rows reject (no warning
// in result), so iterating result.parsed.warnings would undercount.
// This probe matches `0.NN cts/kwh` pattern for value < 1.
const DECIMAL_CTS_PROBE = /\d+[.,]\d+\s*cts?\s*[/\s.]*\s*[kK][wW][hH]/i;

const CLAUSE_ORDER: readonly RegexKwhSourceClause[] = [
  'energy_eur_per_kwh',
  'energy_cts_integer',
  'time_eur_per_min',
  'time_eur_per_hour',
  'flat_session',
];

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      cur += c; i += 1; continue;
    }
    if (c === ',') { fields.push(cur); cur = ''; i += 1; continue; }
    if (c === '"' && cur.length === 0) { inQuotes = true; i += 1; continue; }
    cur += c; i += 1;
  }
  fields.push(cur);
  return fields;
}

function parseArgs(argv: readonly string[]): { csvPath: string } {
  let csvPath = '.cache/irve.csv';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--csv' && i + 1 < argv.length) {
      csvPath = argv[i + 1];
      i += 1;
    }
  }
  return { csvPath };
}

async function main(): Promise<number> {
  const { csvPath } = parseArgs(process.argv.slice(2));

  let totalRows = 0;
  let attempted = 0;
  let succeeded = 0;
  let hallmarkNoClauses = 0;
  let centimesNoteCount = 0;
  let decimalCtsInputRows = 0;
  let subscriptionMarkerCount = 0;
  let prefixContextCount = 0;
  let multiClauseInputCount = 0;
  let timeWindowNoteCount = 0;

  const clauseCounts: Record<RegexKwhSourceClause, number> = {
    energy_eur_per_kwh: 0,
    energy_cts_integer: 0,
    time_eur_per_min: 0,
    time_eur_per_hour: 0,
    flat_session: 0,
  };
  const enseigneCounts = new Map<string, number>();

  // FP guard counters
  let totalSentinelRows = 0;
  let sentinelOverlap = 0;
  let totalDrivecoRows = 0;
  let drivecoOverlap = 0;
  let totalCiteosRows = 0;
  let citeosOverlap = 0;
  let totalUrlRows = 0;
  let urlOverlap = 0;

  const stream = createReadStream(csvPath, { encoding: 'utf8' });
  stream.on('error', (err) => {
    console.error(`environmental fault: cannot open ${csvPath}: ${err.message}`);
    process.exit(2);
  });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let tarifIdx = -1;
  let enseigneIdx = -1;
  let isFirstLine = true;

  for await (const line of rl) {
    if (isFirstLine) {
      const header = splitCsvLine(line);
      tarifIdx = header.indexOf('tarification');
      enseigneIdx = header.indexOf('nom_enseigne');
      if (tarifIdx === -1 || enseigneIdx === -1) {
        console.error(
          `environmental fault: required column missing in header of ${csvPath}`,
        );
        return 2;
      }
      isFirstLine = false;
      continue;
    }

    const fields = splitCsvLine(line);
    const raw = fields[tarifIdx] ?? '';
    const enseigne = fields[enseigneIdx] ?? '<no enseigne>';
    totalRows += 1;

    // Classify into prior-stage territories for FP-guard tracking.
    const sentResult = detectSentinel(raw);
    if (sentResult.isSentinel) totalSentinelRows += 1;
    const ts = raw.trim();
    const isDriveco = ts.startsWith('{') && raw.includes('energyPrice');
    if (isDriveco) totalDrivecoRows += 1;
    const citeosResult = parseCiteosTemplate(raw);
    const isCiteos = citeosResult.ok;
    if (isCiteos) totalCiteosRows += 1;
    const isUrl =
      /^https?:\/\//.test(ts) && ts.length < 200 && !ts.includes(' ');
    if (isUrl) totalUrlRows += 1;
    if (DECIMAL_CTS_PROBE.test(raw)) decimalCtsInputRows += 1;

    const result = parseRegexKwh(raw);
    if (!result.ok) {
      if (result.reason === 'hallmark matched but no atomic clauses extracted') {
        attempted += 1;
        hallmarkNoClauses += 1;
      }
      continue;
    }

    attempted += 1;
    succeeded += 1;

    if (sentResult.isSentinel) sentinelOverlap += 1;
    if (isDriveco) drivecoOverlap += 1;
    if (isCiteos) citeosOverlap += 1;
    if (isUrl) urlOverlap += 1;

    if (result.parsed.elements.length > 1) multiClauseInputCount += 1;
    if (result.parsed.prefixContext) prefixContextCount += 1;
    if (result.parsed.subscriptionMarker) subscriptionMarkerCount += 1;
    if (result.parsed.notes.some((n) => n.startsWith('informational: time-window'))) {
      timeWindowNoteCount += 1;
    }

    enseigneCounts.set(enseigne, (enseigneCounts.get(enseigne) ?? 0) + 1);

    for (const el of result.parsed.elements) {
      clauseCounts[el.sourceClause] += 1;
      if (el.notes.some((n) => n.startsWith('interpreted from centimes'))) {
        centimesNoteCount += 1;
      }
    }
    // (Note: decimal-cts warnings are tracked via DECIMAL_CTS_PROBE on
    // raw input above — propagating warnings via successful results
    // misses the sole-clause-decimal-cts case that rejects.)
  }

  const fmt = (n: number) => n.toLocaleString('en-US').padStart(7);
  const fmt2 = (n: number) => n.toLocaleString('en-US').padStart(5);
  const pct = (n: number) =>
    `(${((n / totalRows) * 100).toFixed(1)}%)`.padStart(8);

  const skipped = totalRows - attempted;
  console.log(
    `P2 regex €/kWh smoke (n=${totalRows.toLocaleString('en-US')} PDC rows, ${csvPath})`,
  );
  console.log(`  Successfully parsed         ${fmt(succeeded)}  ${pct(succeeded)}`);
  console.log(`  Skipped (no hallmark)       ${fmt(skipped)}  ${pct(skipped)}`);
  console.log('');

  console.log('Per-clause occurrence count (across all successful parses):');
  for (const c of CLAUSE_ORDER) {
    console.log(`  ${c.padEnd(28)} ${fmt(clauseCounts[c])}`);
  }
  console.log('');

  console.log('Per-enseigne distribution (top 15):');
  const sortedEns = Array.from(enseigneCounts.entries()).sort(
    (a, b) => b[1] - a[1],
  );
  for (const [ens, c] of sortedEns.slice(0, 15)) {
    console.log(`  ${ens.padEnd(40)} ${fmt2(c)}`);
  }
  if (sortedEns.length > 15) {
    const otherTotal = sortedEns.slice(15).reduce((s, [, c]) => s + c, 0);
    console.log(`  Other ${sortedEns.length - 15} enseignes`.padEnd(42) + ` ${fmt2(otherTotal)}`);
  }
  console.log('');

  console.log('Repair / warning / metadata counts:');
  console.log(`  centimes interpretation notes:        ${fmt2(centimesNoteCount)}`);
  console.log(`  decimal-cts input rows (probe):       ${fmt2(decimalCtsInputRows)}`);
  console.log(`  multi-clause inputs:                  ${fmt2(multiClauseInputCount)}`);
  console.log(`  subscription markers detected:        ${fmt2(subscriptionMarkerCount)}`);
  console.log(`  prefix contexts (AC/HPC/DC/Bornes):   ${fmt2(prefixContextCount)}`);
  console.log(`  time-window informational notes:      ${fmt2(timeWindowNoteCount)}`);
  console.log('');

  console.log('Failure modes:');
  console.log(`  Hallmark matched, 0 clauses extracted: ${hallmarkNoClauses}`);
  console.log('');

  console.log('False-positive guards (must all be 0):');
  console.log(
    `  P5 sentinel territory parsed as P2:    ${sentinelOverlap} of ${totalSentinelRows.toLocaleString('en-US')}  ${sentinelOverlap === 0 ? '✓' : '✗ FAIL'}`,
  );
  console.log(
    `  P0 DRIVECO JSON parsed as P2:          ${drivecoOverlap} of ${totalDrivecoRows.toLocaleString('en-US').padStart(6)}   ${drivecoOverlap === 0 ? '✓' : '✗ FAIL'}`,
  );
  console.log(
    `  P1 CITEOS templates parsed as P2:      ${citeosOverlap} of ${totalCiteosRows.toLocaleString('en-US').padStart(6)}   ${citeosOverlap === 0 ? '✓' : '✗ FAIL'}`,
  );
  console.log(
    `  P3 URL-only parsed as P2:              ${urlOverlap} of ${totalUrlRows.toLocaleString('en-US').padStart(6)}   ${urlOverlap === 0 ? '✓' : '✗ FAIL'}`,
  );
  console.log('');

  const ratio = succeeded / Math.max(attempted, 1);
  const ratioPct = (ratio * 100).toFixed(2);
  console.log('Acceptance:');
  console.log(
    `  Parsed/attempted ratio:   ${succeeded.toLocaleString('en-US')} / ${attempted.toLocaleString('en-US')} = ${ratioPct}%  ${succeeded >= EXPECTED_FLOOR ? '✓' : '✗ FAIL'} (≥ 99% required)`,
  );
  console.log(
    `  Decimal-cts input rows:                ${decimalCtsInputRows} (baseline ${DECIMAL_CTS_BASELINE} ±${DECIMAL_CTS_TOLERANCE})  ${Math.abs(decimalCtsInputRows - DECIMAL_CTS_BASELINE) <= DECIMAL_CTS_TOLERANCE ? '✓' : '✗ FAIL'}`,
  );
  console.log(
    `  Hallmark+0-clauses count:              ${hallmarkNoClauses} (ceiling ${HALLMARK_NOCLAUSE_CEILING})  ${hallmarkNoClauses <= HALLMARK_NOCLAUSE_CEILING ? '✓' : '✗ FAIL'}`,
  );
  console.log('');

  const fpFail =
    sentinelOverlap > 0 || drivecoOverlap > 0 || citeosOverlap > 0 || urlOverlap > 0;
  const successFail = succeeded < EXPECTED_FLOOR;
  const decimalCtsFail =
    Math.abs(decimalCtsInputRows - DECIMAL_CTS_BASELINE) > DECIMAL_CTS_TOLERANCE;
  const hallmarkFail = hallmarkNoClauses > HALLMARK_NOCLAUSE_CEILING;

  if (fpFail) {
    console.error(
      '✗ FAIL: false-positive guard tripped. A prior-stage input parsed as P2. P5/P0/P1/P3 should short-circuit before P2 in the orchestrator chain; this guard catches confused inputs.',
    );
    return 1;
  }
  if (successFail) {
    console.error(
      `✗ FAIL: succeeded=${succeeded} below 99% floor ${EXPECTED_FLOOR} of attempted=${attempted}.`,
    );
    return 1;
  }
  if (decimalCtsFail) {
    console.error(
      `✗ FAIL: decimal-cts input row count ${decimalCtsInputRows} outside baseline ${DECIMAL_CTS_BASELINE} ±${DECIMAL_CTS_TOLERANCE}. Investigate before commit (likely new operator emitting decimal-cts, or change in EVBOX/ZEENCO data).`,
    );
    return 1;
  }
  if (hallmarkFail) {
    console.error(
      `✗ FAIL: hallmark+0-clauses count ${hallmarkNoClauses} above ceiling ${HALLMARK_NOCLAUSE_CEILING}. Likely a new clause variant; investigate.`,
    );
    return 1;
  }

  console.log('✓ all guards pass.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('environmental fault:', err);
    process.exit(2);
  });
