// Sentinel detector smoke runner — diagnostic only.
//
// Reads .cache/irve.csv, applies detectSentinel to each row's
// `tarification` field, prints distribution + false-positive guard
// counts. NO database access. NO writes. Exits non-zero on regression.
//
// Run:
//   pnpm exec tsx tools/parsers-smoke/sentinel.ts
//   pnpm exec tsx tools/parsers-smoke/sentinel.ts --csv path/to/other.csv
//
// Exit codes:
//   0   smoke passed (FP guards clean, total within 95% floor)
//   1   regression detected (FP > 0 OR total < 95% floor)
//   2   environmental fault (CSV missing, header missing, parse error)
//
// This runner is the development counterpart to T13's production
// orchestrator (`tools/run-parsers/`, M1 W5). The orchestrator writes
// to live.parser_outcomes; this smoke does not.

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { detectSentinel, type SentinelRule } from '../../src/lib/parsers/sentinel';

// Anchored against the CSV pre-flight in T09 design summary §1
// (.cache/irve.csv, 2026-05-02, 224,467 PDC rows).
//   Total sentinel hits expected: 184,708
//   95% floor: 175,472
const EXPECTED_TOTAL_FLOOR = 175_472;

const RULE_ORDER: readonly SentinelRule[] = [
  'R1_empty',
  'R2_dash',
  'R3_bool_string',
  'R4_short_no_digits',
  'R5_negation_phrases',
  'R6_powerdot_prefix',
];

type Counts = Record<SentinelRule, number>;

function emptyCounts(): Counts {
  return {
    R1_empty: 0,
    R2_dash: 0,
    R3_bool_string: 0,
    R4_short_no_digits: 0,
    R5_negation_phrases: 0,
    R6_powerdot_prefix: 0,
  };
}

// Minimal RFC-4180 single-line splitter. The IRVE CSV's
// `tarification` field commonly contains commas inside quoted strings
// (e.g. CITEOS templates) but no embedded newlines (verified against
// .cache/irve.csv: line count = header + record count exactly).
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

async function main(): Promise<number> {
  const { csvPath } = parseArgs(process.argv.slice(2));

  const counts = emptyCounts();
  let totalRows = 0;
  let totalSentinel = 0;

  // FP guard buckets. P1+P2 territory tightened to "kwh-text AND has
  // digit" — bare unit markers like `'au kwh'` are legitimately R4
  // sentinels (no number to extract), so requiring a digit narrows
  // the guard to inputs that downstream parsers could actually
  // succeed on.
  let p0Total = 0;
  let p0Sentinel = 0;
  let p1p2Total = 0;
  let p1p2Sentinel = 0;
  let p3Total = 0;
  let p3Sentinel = 0;

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
        console.error(`environmental fault: column "tarification" not found in header of ${csvPath}`);
        return 2;
      }
      isFirstLine = false;
      continue;
    }

    const fields = splitCsvLine(line);
    const raw = fields[tarifIdx] ?? '';
    totalRows += 1;

    const ts = raw.trim();
    const isP0Territory = ts.startsWith('{') && ts.includes('energyPrice');
    const isP3Territory =
      /^https?:\/\//.test(ts) && ts.length < 200 && !ts.includes(' ');
    const isP1P2Territory = /kwh|kw\.?h/i.test(ts) && /\d/.test(ts);

    if (isP0Territory) p0Total += 1;
    if (isP3Territory) p3Total += 1;
    if (isP1P2Territory) p1p2Total += 1;

    const result = detectSentinel(raw);
    if (result.isSentinel) {
      totalSentinel += 1;
      counts[result.rule] += 1;
      if (isP0Territory) p0Sentinel += 1;
      if (isP3Territory) p3Sentinel += 1;
      if (isP1P2Territory) p1p2Sentinel += 1;
    }
  }

  const fmt = (n: number) => n.toLocaleString('en-US').padStart(7);
  const pct = (n: number) =>
    `(${((n / totalRows) * 100).toFixed(1)}%)`.padStart(8);

  console.log(
    `Sentinel detector smoke (n=${totalRows.toLocaleString('en-US')} PDC rows, ${csvPath})`,
  );
  for (const rule of RULE_ORDER) {
    console.log(`  ${rule.padEnd(28)} ${fmt(counts[rule])}  ${pct(counts[rule])}`);
  }
  console.log(`  ─────`);
  console.log(`  Total sentinel              ${fmt(totalSentinel)}  ${pct(totalSentinel)}`);
  console.log('');
  console.log('False-positive guard (must all be 0):');
  const guardLine = (label: string, fp: number, total: number) =>
    `  ${label.padEnd(38)} ${fp} of ${total.toLocaleString('en-US').padStart(6)}   ${
      fp === 0 ? '✓' : '✗ FAIL'
    }`;
  console.log(guardLine('P0 territory ({"energyPrice":...):', p0Sentinel, p0Total));
  console.log(guardLine('P3 territory (https?://...):', p3Sentinel, p3Total));
  console.log(guardLine('P1+P2 territory (kwh + digit):', p1p2Sentinel, p1p2Total));
  console.log('');

  const fpFail = p0Sentinel + p3Sentinel + p1p2Sentinel > 0;
  const totalFail = totalSentinel < EXPECTED_TOTAL_FLOOR;

  if (fpFail) {
    console.error(
      '✗ FAIL: false-positive guard tripped. A sentinel rule classified an input that belongs to a downstream parser. Check R4_WHITELIST / R5_PHRASES / R6_POWERDOT_PREFIX for accidental overlap with parseable inputs.',
    );
    return 1;
  }
  if (totalFail) {
    console.error(
      `✗ FAIL: total sentinel hits ${totalSentinel.toLocaleString('en-US')} below 95% floor ${EXPECTED_TOTAL_FLOOR.toLocaleString('en-US')} (CSV pre-flight expected ~184,708). Either the CSV shape shifted significantly, or a rule regressed.`,
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
