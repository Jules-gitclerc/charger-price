// DRIVECO JSON parser smoke runner — diagnostic only.
//
// Reads .cache/irve.csv, attempts parseDriveCoJson on every row whose
// `tarification` field matches the DRIVECO detection criterion
// (starts-with-'{' AND contains 'energyPrice'), and reports:
//   - success / error / rejected breakdown
//   - cross-tab of (energyPrice × matrixOSF pattern)
//   - false-positive guard against P5 sentinel territory
//
// NO database access. NO writes. Exits non-zero on regression.
//
// Run:
//   pnpm exec tsx tools/parsers-smoke/driveco-json.ts
//   pnpm exec tsx tools/parsers-smoke/driveco-json.ts --csv path/to/other.csv
//
// Exit codes:
//   0   smoke passed
//   1   regression detected (success rate < 99%, OR ≠0 failures, OR FP > 0)
//   2   environmental fault (CSV missing, header missing, etc.)

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { parseDriveCoJson } from '../../src/lib/parsers/driveco-json';
import { detectSentinel } from '../../src/lib/parsers/sentinel';

// Anchored against T10 pre-flight (.cache/irve.csv 2026-05-02):
//   1,553 DRIVECO JSON rows total. Current baseline:
//   - all 1,553 parse cleanly (success)
//   - 0 errors, 0 rejected
//   - 0 sentinel-territory overlap
const EXPECTED_TOTAL = 1553;
const EXPECTED_FLOOR = Math.floor(EXPECTED_TOTAL * 0.99);

// Reused from tools/parsers-smoke/sentinel.ts. Minimal RFC-4180 single-line
// splitter; the IRVE CSV has no embedded newlines (verified at T09).
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = '';
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += c;
      i += 1;
      continue;
    }
    if (c === ',') {
      fields.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    if (c === '"' && cur.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }
    cur += c;
    i += 1;
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

type CrossTabRow = { A: number; B: number; other: number };

async function main(): Promise<number> {
  const { csvPath } = parseArgs(process.argv.slice(2));

  let totalRows = 0;
  let attempted = 0;
  let succeeded = 0;
  let errored = 0;
  let rejected = 0;
  let totalSentinelRows = 0;
  let sentinelOverlap = 0;

  // energyPrice value → { Pattern A count, Pattern B count, other count }
  const crossTab = new Map<number, CrossTabRow>();
  const ensureRow = (ep: number): CrossTabRow => {
    const existing = crossTab.get(ep);
    if (existing) return existing;
    const fresh: CrossTabRow = { A: 0, B: 0, other: 0 };
    crossTab.set(ep, fresh);
    return fresh;
  };

  const stream = createReadStream(csvPath, { encoding: 'utf8' });
  stream.on('error', (err) => {
    console.error(`environmental fault: cannot open ${csvPath}: ${err.message}`);
    process.exit(2);
  });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let tarifIdx = -1;
  let isFirstLine = true;

  for await (const line of rl) {
    if (isFirstLine) {
      const header = splitCsvLine(line);
      tarifIdx = header.indexOf('tarification');
      if (tarifIdx === -1) {
        console.error(
          `environmental fault: column "tarification" not found in header of ${csvPath}`,
        );
        return 2;
      }
      isFirstLine = false;
      continue;
    }

    const fields = splitCsvLine(line);
    const raw = fields[tarifIdx] ?? '';
    totalRows += 1;

    const sentResult = detectSentinel(raw);
    if (sentResult.isSentinel) totalSentinelRows += 1;

    // Same detection criterion as T10 pre-flight (zero ambiguity:
    // 0 starts-with-'{' rows lacked 'energyPrice', and 0 'energyPrice'-
    // bearing rows lacked the leading brace).
    const ts = raw.trim();
    if (!ts.startsWith('{') || !raw.includes('energyPrice')) continue;

    attempted += 1;
    const result = parseDriveCoJson(raw);
    if (!result.ok) {
      if (result.outcome === 'error') errored += 1;
      else rejected += 1;
      continue;
    }
    succeeded += 1;

    const ep = result.parsed.energyPriceEurPerKwh;
    const row = ensureRow(ep);
    if (result.parsed.osfTiers.length === 2) row.A += 1;
    else if (result.parsed.osfTiers.length === 1) row.B += 1;
    else row.other += 1;

    if (sentResult.isSentinel) sentinelOverlap += 1;
  }

  const fmt = (n: number) => n.toLocaleString('en-US').padStart(7);
  const fmt2 = (n: number) => n.toLocaleString('en-US').padStart(5);
  const pct = (n: number) =>
    `(${((n / totalRows) * 100).toFixed(1)}%)`.padStart(8);

  const skipped = totalRows - attempted;
  console.log(
    `DRIVECO JSON parser smoke (n=${totalRows.toLocaleString('en-US')} PDC rows, ${csvPath})`,
  );
  console.log(`  Successfully parsed         ${fmt(succeeded)}  ${pct(succeeded)}`);
  console.log(`  Skipped (not JSON-shaped)   ${fmt(skipped)}  ${pct(skipped)}`);
  console.log('');

  console.log('Cross-tab (energyPrice × matrixOSF pattern):');
  console.log(
    '                  Pattern A (waiver)   Pattern B (grace only)   Total',
  );
  // Sort energyPrice DESC by total count (so the largest groups come first).
  const sortedEntries = Array.from(crossTab.entries()).sort(
    (a, b) => b[1].A + b[1].B + b[1].other - (a[1].A + a[1].B + a[1].other),
  );
  let totalA = 0;
  let totalB = 0;
  for (const [ep, row] of sortedEntries) {
    const aCell = row.A === 0 ? '—' : fmt2(row.A);
    const bCell = row.B === 0 ? '—' : fmt2(row.B);
    const total = row.A + row.B + row.other;
    totalA += row.A;
    totalB += row.B;
    console.log(
      `  energyPrice=${ep.toFixed(2)}        ${aCell.padStart(5)}                  ${bCell.padStart(5)}             ${fmt2(total)}`,
    );
  }
  console.log(`  ─────                  ─────                ─────             ─────`);
  console.log(
    `  Total                   ${fmt2(totalA)}                  ${fmt2(totalB)}             ${fmt2(succeeded)}`,
  );
  console.log('');

  console.log('Failure modes:');
  console.log(`  Malformed JSON (parse error):            ${errored}`);
  console.log(`  Recognized-as-DRIVECO-attempted-rejected:${rejected}`);
  console.log('');

  console.log('False-positive guard:');
  console.log(
    `  P5 sentinel territory parsed as DRIVECO: ${sentinelOverlap} of ${totalSentinelRows.toLocaleString('en-US')}  ${sentinelOverlap === 0 ? '✓' : '✗ FAIL'}`,
  );
  console.log('');

  const ratio = succeeded / Math.max(attempted, 1);
  const ratioPct = (ratio * 100).toFixed(2);
  console.log('Acceptance:');
  console.log(
    `  Parsed/attempted ratio:   ${succeeded.toLocaleString('en-US')} / ${attempted.toLocaleString('en-US')} = ${ratioPct}%  ${succeeded >= EXPECTED_FLOOR ? '✓' : '✗ FAIL'} (≥ 99% required)`,
  );
  console.log(
    `  Failure modes total:               ${errored + rejected} of ${attempted.toLocaleString('en-US')}  ${errored + rejected === 0 ? '✓' : '✗ FAIL'} (exact 0 baseline)`,
  );
  console.log('');

  const fpFail = sentinelOverlap > 0;
  const successFail = succeeded < EXPECTED_FLOOR;
  const failureBaselineFail = errored + rejected > 0;

  if (fpFail) {
    console.error(
      '✗ FAIL: P5 sentinel territory overlaps DRIVECO success — a sentinel-class input parsed as DRIVECO. P5 should short-circuit before P0 in the orchestrator chain, but this guard catches confused inputs.',
    );
    return 1;
  }
  if (successFail) {
    console.error(
      `✗ FAIL: succeeded=${succeeded} below 99% floor ${EXPECTED_FLOOR} of attempted=${attempted}. Either CSV shape shifted or parser regressed.`,
    );
    return 1;
  }
  if (failureBaselineFail) {
    console.error(
      `✗ FAIL: failure modes nonzero (errored=${errored}, rejected=${rejected}). Current baseline is exact 0 — investigate before commit.`,
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
