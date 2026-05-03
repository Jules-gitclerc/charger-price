// CITEOS template parser smoke runner — diagnostic only.
//
// Reads .cache/irve.csv, applies parseCiteosTemplate to every row,
// reports:
//   - success / rejected breakdown (no error path for this parser)
//   - per-clause-type histogram across all extracted elements
//   - per-enseigne distribution
//   - clause-set signature distribution (top 10)
//   - comma-bug repair count
//   - multi-price warning count
//   - false-positive guards against P5 sentinel + P0 DRIVECO territory
//
// NO database access. NO writes. Exits non-zero on regression.
//
// Run:
//   pnpm exec tsx tools/parsers-smoke/citeos-template.ts
//   pnpm exec tsx tools/parsers-smoke/citeos-template.ts --csv path/to/other.csv
//
// Exit codes:
//   0   smoke passed
//   1   regression (FP > 0, success rate < 99% of attempted, OR
//       hallmark+0-clauses count > 0 baseline)
//   2   environmental fault

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import {
  parseCiteosTemplate,
  type CiteosSourceClause,
} from '../../src/lib/parsers/citeos-template';
import { detectSentinel } from '../../src/lib/parsers/sentinel';

// Anchored against T11 pre-flight (.cache/irve.csv 2026-05-02):
//   12,020 hallmark-matching rows. All extract ≥1 atomic clause.
//   Baseline: 0 hallmark+0-clauses, 0 errors (no error path), 0 FP.
const EXPECTED_TOTAL = 12_020;
const EXPECTED_FLOOR = Math.floor(EXPECTED_TOTAL * 0.99);

const CLAUSE_ORDER: readonly CiteosSourceClause[] = [
  'bare_energy',
  'time_window_energy',
  'default_energy',
  'bare_parking_off',
  'bare_charging_time',
  'time_window_parking_off',
  'default_parking_off',
  'time_window_charging_time',
  'default_start_fee',
  'time_window_start_fee',
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
  let commaBugRepairs = 0;
  let multiPriceWarnings = 0;

  const clauseCounts: Record<CiteosSourceClause, number> = {
    bare_energy: 0,
    time_window_energy: 0,
    default_energy: 0,
    bare_parking_off: 0,
    bare_charging_time: 0,
    time_window_parking_off: 0,
    default_parking_off: 0,
    time_window_charging_time: 0,
    default_start_fee: 0,
    time_window_start_fee: 0,
  };
  const enseigneCounts = new Map<string, number>();
  const signatureCounts = new Map<string, number>();

  // FP guards
  let totalSentinelRows = 0;
  let sentinelOverlap = 0;
  let drivecoOverlap = 0;
  let totalDrivecoRows = 0;

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
      if (tarifIdx === -1) {
        console.error(
          `environmental fault: column "tarification" not found in header of ${csvPath}`,
        );
        return 2;
      }
      if (enseigneIdx === -1) {
        console.error(
          `environmental fault: column "nom_enseigne" not found in header of ${csvPath}`,
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

    const sentResult = detectSentinel(raw);
    if (sentResult.isSentinel) totalSentinelRows += 1;
    const ts = raw.trim();
    const isDriveco = ts.startsWith('{') && raw.includes('energyPrice');
    if (isDriveco) totalDrivecoRows += 1;

    const result = parseCiteosTemplate(raw);
    if (!result.ok) {
      if (result.reason === 'hallmark matched but no atomic clauses extracted') {
        // Hallmark present but no clauses — would be a real regression.
        attempted += 1;
        hallmarkNoClauses += 1;
      }
      continue;
    }

    attempted += 1;
    succeeded += 1;

    if (sentResult.isSentinel) sentinelOverlap += 1;
    if (isDriveco) drivecoOverlap += 1;

    const sourceClausesInRow = new Set<CiteosSourceClause>();
    for (const el of result.parsed.elements) {
      clauseCounts[el.sourceClause] += 1;
      sourceClausesInRow.add(el.sourceClause);
    }
    enseigneCounts.set(enseigne, (enseigneCounts.get(enseigne) ?? 0) + 1);

    const sig = Array.from(sourceClausesInRow).sort().join('+');
    signatureCounts.set(sig, (signatureCounts.get(sig) ?? 0) + 1);

    for (const w of result.parsed.warnings) {
      if (w.startsWith('upstream stringification artifact')) commaBugRepairs += 1;
      if (w.startsWith('multiple distinct prices')) multiPriceWarnings += 1;
    }
  }

  const fmt = (n: number) => n.toLocaleString('en-US').padStart(7);
  const fmt2 = (n: number) => n.toLocaleString('en-US').padStart(5);
  const pct = (n: number) =>
    `(${((n / totalRows) * 100).toFixed(1)}%)`.padStart(8);

  const skipped = totalRows - attempted;
  console.log(
    `CITEOS template parser smoke (n=${totalRows.toLocaleString('en-US')} PDC rows, ${csvPath})`,
  );
  console.log(`  Successfully parsed         ${fmt(succeeded)}  ${pct(succeeded)}`);
  console.log(`  Skipped (no hallmark)       ${fmt(skipped)}  ${pct(skipped)}`);
  console.log('');

  console.log('Per-clause occurrence count (across all successful parses):');
  for (const c of CLAUSE_ORDER) {
    console.log(`  ${c.padEnd(28)} ${fmt(clauseCounts[c])}`);
  }
  console.log('');

  console.log('Per-enseigne distribution:');
  const sortedEnseignes = Array.from(enseigneCounts.entries()).sort(
    (a, b) => b[1] - a[1],
  );
  for (const [ens, c] of sortedEnseignes) {
    console.log(`  ${ens.padEnd(40)} ${fmt2(c)}`);
  }
  console.log('');

  console.log('Clause-set signature distribution (top 10):');
  const sortedSigs = Array.from(signatureCounts.entries()).sort(
    (a, b) => b[1] - a[1],
  );
  const top10 = sortedSigs.slice(0, 10);
  let topSum = 0;
  for (const [sig, c] of top10) {
    topSum += c;
    const sigLabel = sig.length > 70 ? `${sig.slice(0, 67)}...` : sig;
    console.log(`  ${fmt2(c)}  ${sigLabel}`);
  }
  const otherCount = succeeded - topSum;
  if (sortedSigs.length > 10) {
    console.log(`  ${fmt2(otherCount)}  Other ${sortedSigs.length - 10} signatures`);
  }
  console.log(`  Total signatures observed: ${sortedSigs.length}`);
  console.log('');

  console.log('Repair / warning counts:');
  console.log(`  comma-bug repairs:                       ${commaBugRepairs}`);
  console.log(`  multi-price warnings:                    ${multiPriceWarnings}`);
  console.log('');

  console.log('Failure modes:');
  console.log(`  Hallmark matched, 0 clauses extracted:   ${hallmarkNoClauses}`);
  console.log('');

  console.log('False-positive guards:');
  console.log(
    `  P5 sentinel territory parsed as CITEOS:  ${sentinelOverlap} of ${totalSentinelRows.toLocaleString('en-US')}  ${sentinelOverlap === 0 ? '✓' : '✗ FAIL'}`,
  );
  console.log(
    `  P0 DRIVECO JSON parsed as CITEOS:        ${drivecoOverlap} of ${totalDrivecoRows.toLocaleString('en-US').padStart(6)}   ${drivecoOverlap === 0 ? '✓' : '✗ FAIL'}`,
  );
  console.log('');

  const ratio = succeeded / Math.max(attempted, 1);
  const ratioPct = (ratio * 100).toFixed(2);
  console.log('Acceptance:');
  console.log(
    `  Parsed/attempted ratio:   ${succeeded.toLocaleString('en-US')} / ${attempted.toLocaleString('en-US')} = ${ratioPct}%  ${succeeded >= EXPECTED_FLOOR ? '✓' : '✗ FAIL'} (≥ 99% required)`,
  );
  console.log(
    `  Hallmark+0-clauses count:                ${hallmarkNoClauses}  ${hallmarkNoClauses === 0 ? '✓' : '✗ FAIL'} (exact 0 baseline)`,
  );
  console.log('');

  const fpFail = sentinelOverlap > 0 || drivecoOverlap > 0;
  const successFail = succeeded < EXPECTED_FLOOR;
  const baselineFail = hallmarkNoClauses > 0;

  if (fpFail) {
    console.error(
      '✗ FAIL: false-positive guard tripped. A sentinel- or DRIVECO-class input parsed as CITEOS. P5 / P0 should short-circuit before P1 in the orchestrator chain; this guard catches confused inputs.',
    );
    return 1;
  }
  if (successFail) {
    console.error(
      `✗ FAIL: succeeded=${succeeded} below 99% floor ${EXPECTED_FLOOR} of attempted=${attempted}. Either CSV shape shifted or parser regressed.`,
    );
    return 1;
  }
  if (baselineFail) {
    console.error(
      `✗ FAIL: hallmark+0-clauses count = ${hallmarkNoClauses}. Current baseline is exact 0 — investigate before commit (likely a new clause variant).`,
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
