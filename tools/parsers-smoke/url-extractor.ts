// P3 URL extractor smoke runner — diagnostic only.
//
// Reads .cache/irve.csv, applies parseUrlExtractor to every row,
// reports:
//   - success / rejected breakdown
//   - per-distinct-URL distribution (top 11 from pre-flight)
//   - per-enseigne distribution (top 10)
//   - false-positive guards against P5 + P0 + P1 + P2 territory (4 guards)
//
// NO database access. NO writes. Exits non-zero on regression.
//
// Run:
//   pnpm exec tsx tools/parsers-smoke/url-extractor.ts
//   pnpm exec tsx tools/parsers-smoke/url-extractor.ts --csv path/to/other.csv
//
// Exit codes:
//   0   smoke passed
//   1   regression (recovery != exact baseline, OR FP > 0)
//   2   environmental fault

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { parseUrlExtractor } from '../../src/lib/parsers/url-extractor';
import { detectSentinel } from '../../src/lib/parsers/sentinel';
import { parseCiteosTemplate } from '../../src/lib/parsers/citeos-template';
import { parseRegexKwh } from '../../src/lib/parsers/regex-kwh';

// Anchored against T13 pre-flight (.cache/irve.csv 2026-05-02):
//   8,384 URL-only rows. Pre-flight showed ALL clean — 0 mixed, 0
//   malformed, 0 with prefix text. Acceptance is exact baseline (not
//   a tolerance band): drift signals real corpus shift.
const EXPECTED_TOTAL = 8_384;

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
  let succeeded = 0;
  let rejected = 0;
  let errored = 0;

  const urlCounts = new Map<string, number>();
  const enseigneCounts = new Map<string, number>();

  // FP guard counters
  let totalSentinelRows = 0;
  let sentinelOverlap = 0;
  let totalDrivecoRows = 0;
  let drivecoOverlap = 0;
  let totalCiteosRows = 0;
  let citeosOverlap = 0;
  let totalP2Rows = 0;
  let p2Overlap = 0;

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
        console.error(`environmental fault: required column missing in header of ${csvPath}`);
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
    const isCiteos = parseCiteosTemplate(raw).ok;
    if (isCiteos) totalCiteosRows += 1;
    const isP2 = parseRegexKwh(raw).ok;
    if (isP2) totalP2Rows += 1;

    const result = parseUrlExtractor(raw);
    if (!result.ok) {
      if (result.outcome === 'error') errored += 1;
      else rejected += 1;
      continue;
    }

    succeeded += 1;
    urlCounts.set(result.parsed.url, (urlCounts.get(result.parsed.url) ?? 0) + 1);
    enseigneCounts.set(enseigne, (enseigneCounts.get(enseigne) ?? 0) + 1);

    if (sentResult.isSentinel) sentinelOverlap += 1;
    if (isDriveco) drivecoOverlap += 1;
    if (isCiteos) citeosOverlap += 1;
    if (isP2) p2Overlap += 1;
  }

  const fmt = (n: number) => n.toLocaleString('en-US').padStart(7);
  const fmt2 = (n: number) => n.toLocaleString('en-US').padStart(5);
  const pct = (n: number) =>
    `(${((n / totalRows) * 100).toFixed(1)}%)`.padStart(8);

  console.log(
    `P3 URL extractor smoke (n=${totalRows.toLocaleString('en-US')} PDC rows, ${csvPath})`,
  );
  console.log(`  Successfully parsed         ${fmt(succeeded)}  ${pct(succeeded)}`);
  console.log(`  Rejected                    ${fmt(rejected)}  ${pct(rejected)}`);
  console.log(`  Errored (URL constructor):  ${fmt(errored)}`);
  console.log('');

  console.log(`Per-URL distribution (${urlCounts.size} distinct URLs):`);
  const sortedUrls = Array.from(urlCounts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [u, c] of sortedUrls) {
    const truncated = u.length > 70 ? `${u.slice(0, 67)}...` : u;
    console.log(`  ${fmt2(c)}  ${truncated}`);
  }
  console.log('');

  console.log('Per-enseigne distribution (top 10):');
  const sortedEns = Array.from(enseigneCounts.entries()).sort((a, b) => b[1] - a[1]);
  for (const [ens, c] of sortedEns.slice(0, 10)) {
    console.log(`  ${ens.padEnd(40)} ${fmt2(c)}`);
  }
  if (sortedEns.length > 10) {
    const otherTotal = sortedEns.slice(10).reduce((s, [, c]) => s + c, 0);
    console.log(`  Other ${sortedEns.length - 10} enseignes`.padEnd(42) + ` ${fmt2(otherTotal)}`);
  }
  console.log('');

  console.log('False-positive guards (must all be 0):');
  console.log(
    `  P5 sentinel territory parsed as P3:    ${sentinelOverlap} of ${totalSentinelRows.toLocaleString('en-US')}  ${sentinelOverlap === 0 ? '✓' : '✗ FAIL'}`,
  );
  console.log(
    `  P0 DRIVECO JSON parsed as P3:          ${drivecoOverlap} of ${totalDrivecoRows.toLocaleString('en-US').padStart(6)}   ${drivecoOverlap === 0 ? '✓' : '✗ FAIL'}`,
  );
  console.log(
    `  P1 CITEOS templates parsed as P3:      ${citeosOverlap} of ${totalCiteosRows.toLocaleString('en-US').padStart(6)}   ${citeosOverlap === 0 ? '✓' : '✗ FAIL'}`,
  );
  console.log(
    `  P2 regex-kwh parsed as P3:             ${p2Overlap} of ${totalP2Rows.toLocaleString('en-US').padStart(6)}   ${p2Overlap === 0 ? '✓' : '✗ FAIL'}`,
  );
  console.log('');

  console.log('Acceptance:');
  console.log(
    `  Successfully parsed:           ${succeeded.toLocaleString('en-US')} (baseline ${EXPECTED_TOTAL.toLocaleString('en-US')} exact)  ${succeeded === EXPECTED_TOTAL ? '✓' : '✗ FAIL'}`,
  );
  console.log(
    `  Rejected count:                ${rejected.toLocaleString('en-US')} of ${totalRows.toLocaleString('en-US')}  (every non-URL row)`,
  );
  console.log(
    `  Errored count:                 ${errored} (exact 0 baseline)  ${errored === 0 ? '✓' : '✗ FAIL'}`,
  );
  console.log('');

  const fpFail =
    sentinelOverlap > 0 || drivecoOverlap > 0 || citeosOverlap > 0 || p2Overlap > 0;
  const recoveryFail = succeeded !== EXPECTED_TOTAL;
  const errFail = errored > 0;

  if (fpFail) {
    console.error(
      '✗ FAIL: false-positive guard tripped. A prior-stage input parsed as P3. P5/P0/P1/P2 should short-circuit before P3 in the orchestrator chain; this guard catches confused inputs.',
    );
    return 1;
  }
  if (recoveryFail) {
    console.error(
      `✗ FAIL: parsed count ${succeeded} ≠ exact baseline ${EXPECTED_TOTAL}. Investigate before commit (likely new URL pattern in CSV refresh, or hallmark regex regression).`,
    );
    return 1;
  }
  if (errFail) {
    console.error(
      `✗ FAIL: errored count ${errored} > 0 (URL constructor threw on a hallmark-matching input).`,
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
