// tools/run-parsers/main.ts — T13.2
//
// Parser pipeline orchestrator (P5 → P0 → P1 → P2 → P3) for Prix-Bornes M1.
//
// The first parser-write task of W5: reads live.stations.tarification (populated
// by T13.0.5 workaround OR T13.0 canonical sync — orchestrator is agnostic to
// source path), runs the chain in priority order, writes structured tariff rows
// + parser_outcomes audit trail. Per W5 hard rule #1, parsers OWN
// live.station_tariffs and live.parser_outcomes. T06+ swap functions stay
// immutable.
//
// CHAIN SEMANTICS (architecture §2.4)
// -----------------------------------
// First-match-wins: P5 → P0 → P1 → P2 → P3 → NO_HIT
//   - P5 sentinel    → parser_outcomes(outcome='unknown'); NO station_tariffs
//   - P0 DRIVECO     → parser_outcomes(outcome='success') + tariff/elements/
//                      components/station_tariffs rows
//   - P1 CITEOS      → same as P0 but multi-element + restrictions
//   - P2 regex-kwh   → same shape as P1
//   - P3 URL         → parser_outcomes(outcome='success') + UPDATE
//                      live.stations.tariff_url; NO station_tariffs
//   - NO_HIT (all 5 rejected) → parser_outcomes(source=parser_orchestrator,
//                      outcome='rejected'); NO station_tariffs
//
// CONFIDENCE TIER (W5 hard rule #6)
// ---------------------------------
// All P0/P1/P2 hits emit station_tariffs.confidence='parsed'. T14 will add
// 'verified' for Fastned scrapes. Strict enforcement.
//
// MULTI-ELEMENT MAPPING (per §6 of T13 design summary)
// ----------------------------------------------------
// T10 DRIVECO: 1 ENERGY tariff_element + N PARKING_TIME elements (matrixOSF
//              tiers) with min/max_duration restrictions
// T11 CITEOS:  1 tariff_element per CiteosElement, with start_time/end_time
//              restrictions for time_window_X clauses
// T12 regex-kwh: 1 tariff_element per RegexKwhElement, no restrictions in v1
//
// DEDUPE (W5 hard rule preserved — no orchestrator-side dedupe in M1)
// ------------------------------------------------------------------
// T11/T12 emit redundant elements (bare_X + default_X same price) and
// multi-price warnings (FRBFCEVDIJZ1-class). Orchestrator emits ALL elements
// faithful to parser output. parser_outcomes.parsed_value_json.warnings
// preserves the warnings. T15 viewer disambiguation deferred to M1.5.
//
// SUBSCRIPTION MARKERS (per §6 of T13 design summary)
// --------------------------------------------------
// T12 emits raw subscriptionMarker text. Orchestrator preserves in
// parser_outcomes.parsed_value_json. live.subscriptions empty in M1; resolution
// is M1.5 territory. station_tariffs.subscription_id stays NULL.
//
// E15 ATOMICITY CONTRACT
// ----------------------
// Open ingestion_runs row OUTSIDE the work transaction (visible even on
// rollback). All work in single transaction. On commit: separate UPDATE to
// close run as 'success'. On failure: separate UPDATE to close as 'failed'
// with error_message preserved.
//
// PRE-RUN GATE
// ------------
// Disk audit at 340 MB threshold (legacy Pro-tier-pending). Mid-run audit
// not feasible in single-tx model. Forecast db_size delta: ~+15 MB.
// Headroom comfortable.
//
// USAGE
//   pnpm exec tsx tools/run-parsers/main.ts --dry-run    # forecast only, no writes
//   pnpm exec tsx tools/run-parsers/main.ts              # real run

import postgres from 'postgres';
import crypto from 'node:crypto';

import { detectSentinel, PARSER_VERSION as SENTINEL_V } from '../../src/lib/parsers/sentinel';
import {
  parseDriveCoJson,
  PARSER_VERSION as DRIVECO_V,
  type DriveCoParsed,
} from '../../src/lib/parsers/driveco-json';
import {
  parseCiteosTemplate,
  PARSER_VERSION as CITEOS_V,
  type CiteosTemplateParsed,
  type CiteosElement,
} from '../../src/lib/parsers/citeos-template';
import {
  parseRegexKwh,
  PARSER_VERSION as REGEX_KWH_V,
  type RegexKwhParsed,
  type RegexKwhElement,
} from '../../src/lib/parsers/regex-kwh';
import {
  parseUrlExtractor,
  PARSER_VERSION as URL_V,
  type UrlExtractorParsed,
} from '../../src/lib/parsers/url-extractor';

// ─── Constants ────────────────────────────────────────────────────────

const ORCHESTRATOR_VERSION = 'parser-orchestrator-v1' as const;
const ORCHESTRATOR_SOURCE_SLUG = 'parser_orchestrator' as const;
const DISK_GATE_BYTES = 340 * 1024 * 1024;

// Source slugs from migration 0005:107-119 — already seeded.
const SOURCE_SLUGS = {
  sentinel: 'sentinel_detector',
  driveco: 'driveco_irve_json',
  citeos: 'citeos_template_parser',
  regex_kwh: 'regex_kwh_parser',
  url: 'url_extractor',
  orchestrator: ORCHESTRATOR_SOURCE_SLUG,
} as const;

// ─── Types ────────────────────────────────────────────────────────────

type ChainHit =
  | { stage: 'P5'; sourceSlug: string; parserVersion: string; rule: string }
  | { stage: 'P0'; sourceSlug: string; parserVersion: string; parsed: DriveCoParsed }
  | { stage: 'P1'; sourceSlug: string; parserVersion: string; parsed: CiteosTemplateParsed }
  | { stage: 'P2'; sourceSlug: string; parserVersion: string; parsed: RegexKwhParsed }
  | { stage: 'P3'; sourceSlug: string; parserVersion: string; parsed: UrlExtractorParsed }
  | { stage: 'NO_HIT'; sourceSlug: string; parserVersion: string };

type StationInput = {
  id_station_itinerance: string;
  tarification: string;
};

type StationOutput = {
  station: StationInput;
  rawInputHash: string;
  hit: ChainHit;
};

// ─── Chain ────────────────────────────────────────────────────────────

function runChain(raw: string): ChainHit {
  // P5 sentinel — short-circuits everything else
  const sent = detectSentinel(raw);
  if (sent.isSentinel) {
    return {
      stage: 'P5',
      sourceSlug: SOURCE_SLUGS.sentinel,
      parserVersion: SENTINEL_V,
      rule: sent.rule,
    };
  }
  // P0 DRIVECO JSON
  const driveco = parseDriveCoJson(raw);
  if (driveco.ok) {
    return {
      stage: 'P0',
      sourceSlug: SOURCE_SLUGS.driveco,
      parserVersion: DRIVECO_V,
      parsed: driveco.parsed,
    };
  }
  // P1 CITEOS template
  const citeos = parseCiteosTemplate(raw);
  if (citeos.ok) {
    return {
      stage: 'P1',
      sourceSlug: SOURCE_SLUGS.citeos,
      parserVersion: CITEOS_V,
      parsed: citeos.parsed,
    };
  }
  // P2 regex €/kWh
  const regexK = parseRegexKwh(raw);
  if (regexK.ok) {
    return {
      stage: 'P2',
      sourceSlug: SOURCE_SLUGS.regex_kwh,
      parserVersion: REGEX_KWH_V,
      parsed: regexK.parsed,
    };
  }
  // P3 URL extractor
  const url = parseUrlExtractor(raw);
  if (url.ok) {
    return {
      stage: 'P3',
      sourceSlug: SOURCE_SLUGS.url,
      parserVersion: URL_V,
      parsed: url.parsed,
    };
  }
  // No parser hit
  return {
    stage: 'NO_HIT',
    sourceSlug: SOURCE_SLUGS.orchestrator,
    parserVersion: ORCHESTRATOR_VERSION,
  };
}

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

// ─── OCPI row builders (per-stage adapters) ───────────────────────────
//
// Each builder returns the exact row shape the bulk-INSERT step expects.
// Tariffs table uses gen_random_uuid() default, but we need to know the id
// upfront to wire the FK chain. We generate UUIDs application-side via
// crypto.randomUUID().

type TariffRow = {
  id: string;
  slug: string;
  display_name: string;
  tariff_type: string;
  currency: string;
  source_slug: string;  // resolved to source_id via lookup
};

type TariffElementRow = {
  id: string;
  tariff_id: string;
  sequence_number: number;
};

type PriceComponentRow = {
  tariff_element_id: string;
  type: 'ENERGY' | 'TIME' | 'FLAT' | 'PARKING_TIME';
  price: number;
  step_size: number;
};

type TariffRestrictionRow = {
  tariff_element_id: string;
  start_time?: string | null;
  end_time?: string | null;
  min_duration?: number | null;
  max_duration?: number | null;
};

type StationTariffRow = {
  station_id: string;
  payment_method_slug: string;  // resolved to payment_method_id via lookup
  tariff_id: string;
  confidence: 'verified' | 'parsed' | 'estimated' | 'unknown';
  source_slug: string;
  parser_version: string;
};

type ParserOutcomeRow = {
  source_slug: string;
  raw_input: string;
  raw_input_hash: string;
  outcome: 'success' | 'unknown' | 'rejected' | 'error';
  parsed_value_json: object | null;
  parser_version: string;
};

type TariffUrlUpdate = {
  station_id: string;
  url: string;
};

type WriteSet = {
  tariffs: TariffRow[];
  tariff_elements: TariffElementRow[];
  price_components: PriceComponentRow[];
  tariff_restrictions: TariffRestrictionRow[];
  station_tariffs: StationTariffRow[];
  parser_outcomes: ParserOutcomeRow[];
  tariff_url_updates: TariffUrlUpdate[];
};

function emptyWriteSet(): WriteSet {
  return {
    tariffs: [],
    tariff_elements: [],
    price_components: [],
    tariff_restrictions: [],
    station_tariffs: [],
    parser_outcomes: [],
    tariff_url_updates: [],
  };
}

function tariffSlug(stationId: string, sourceSlug: string): string {
  // Slug constraint: lowercase, no whitespace. Format station-id-source
  return `${stationId.toLowerCase()}_${sourceSlug}`.slice(0, 200);
}

// Adapt DriveCoParsed → tariff/elements/components rows
function buildDrivecoRows(out: StationOutput, ws: WriteSet): void {
  if (out.hit.stage !== 'P0') return;
  const parsed = out.hit.parsed;
  const tariffId = crypto.randomUUID();
  ws.tariffs.push({
    id: tariffId,
    slug: tariffSlug(out.station.id_station_itinerance, out.hit.sourceSlug),
    display_name: `DRIVECO ${parsed.energyPriceEurPerKwh}€/kWh @ ${out.station.id_station_itinerance}`,
    tariff_type: 'AD_HOC',
    currency: 'EUR',
    source_slug: out.hit.sourceSlug,
  });

  // Sequence 0: ENERGY component
  const energyElementId = crypto.randomUUID();
  ws.tariff_elements.push({ id: energyElementId, tariff_id: tariffId, sequence_number: 0 });
  ws.price_components.push({
    tariff_element_id: energyElementId,
    type: 'ENERGY',
    price: parsed.energyPriceEurPerKwh,
    step_size: 1000,
  });

  // Sequence 1+: PARKING_TIME tiers from osfTiers
  for (let i = 0; i < parsed.osfTiers.length; i += 1) {
    const tier = parsed.osfTiers[i];
    const elemId = crypto.randomUUID();
    ws.tariff_elements.push({ id: elemId, tariff_id: tariffId, sequence_number: i + 1 });
    ws.price_components.push({
      tariff_element_id: elemId,
      type: 'PARKING_TIME',
      price: tier.pricePerHourEur,
      step_size: 60,
    });
    ws.tariff_restrictions.push({
      tariff_element_id: elemId,
      min_duration: tier.fromSeconds,
      max_duration: tier.toSeconds,
    });
  }

  ws.station_tariffs.push({
    station_id: out.station.id_station_itinerance,
    payment_method_slug: 'cb_direct',
    tariff_id: tariffId,
    confidence: 'parsed',
    source_slug: out.hit.sourceSlug,
    parser_version: out.hit.parserVersion,
  });
}

// Map CiteosElement → OCPI dimension/step_size tuple
function citeosOcpi(el: CiteosElement): { ocpi_type: PriceComponentRow['type']; step_size: number } {
  switch (el.dimension) {
    case 'ENERGY': return { ocpi_type: 'ENERGY', step_size: 1000 };
    case 'PARKING_TIME': return { ocpi_type: 'PARKING_TIME', step_size: 3600 };
    case 'TIME': return { ocpi_type: 'TIME', step_size: 3600 };
    case 'FLAT': return { ocpi_type: 'FLAT', step_size: 1 };
  }
}

function buildCiteosRows(out: StationOutput, ws: WriteSet): void {
  if (out.hit.stage !== 'P1') return;
  const parsed = out.hit.parsed;
  if (parsed.elements.length === 0) return;

  const tariffId = crypto.randomUUID();
  ws.tariffs.push({
    id: tariffId,
    slug: tariffSlug(out.station.id_station_itinerance, out.hit.sourceSlug),
    display_name: `CITEOS template @ ${out.station.id_station_itinerance}`,
    tariff_type: 'AD_HOC',
    currency: 'EUR',
    source_slug: out.hit.sourceSlug,
  });

  parsed.elements.forEach((el, i) => {
    const elemId = crypto.randomUUID();
    ws.tariff_elements.push({ id: elemId, tariff_id: tariffId, sequence_number: i });
    const ocpi = citeosOcpi(el);
    ws.price_components.push({
      tariff_element_id: elemId,
      type: ocpi.ocpi_type,
      price: el.pricePerUnitEur,
      step_size: ocpi.step_size,
    });
    if (el.restriction !== null) {
      ws.tariff_restrictions.push({
        tariff_element_id: elemId,
        start_time: el.restriction.startLocal,
        end_time: el.restriction.endLocal,
      });
    }
  });

  ws.station_tariffs.push({
    station_id: out.station.id_station_itinerance,
    payment_method_slug: 'cb_direct',
    tariff_id: tariffId,
    confidence: 'parsed',
    source_slug: out.hit.sourceSlug,
    parser_version: out.hit.parserVersion,
  });
}

function regexKwhOcpi(el: RegexKwhElement): { ocpi_type: PriceComponentRow['type']; step_size: number } {
  switch (el.dimension) {
    case 'ENERGY': return { ocpi_type: 'ENERGY', step_size: 1000 };
    case 'TIME': return { ocpi_type: 'TIME', step_size: 3600 };
    case 'FLAT': return { ocpi_type: 'FLAT', step_size: 1 };
  }
}

function buildRegexKwhRows(out: StationOutput, ws: WriteSet): void {
  if (out.hit.stage !== 'P2') return;
  const parsed = out.hit.parsed;
  if (parsed.elements.length === 0) return;

  const tariffId = crypto.randomUUID();
  ws.tariffs.push({
    id: tariffId,
    slug: tariffSlug(out.station.id_station_itinerance, out.hit.sourceSlug),
    display_name: `regex €/kWh @ ${out.station.id_station_itinerance}`,
    tariff_type: 'AD_HOC',
    currency: 'EUR',
    source_slug: out.hit.sourceSlug,
  });

  parsed.elements.forEach((el, i) => {
    const elemId = crypto.randomUUID();
    ws.tariff_elements.push({ id: elemId, tariff_id: tariffId, sequence_number: i });
    const ocpi = regexKwhOcpi(el);
    ws.price_components.push({
      tariff_element_id: elemId,
      type: ocpi.ocpi_type,
      price: el.pricePerUnitEur,
      step_size: ocpi.step_size,
    });
  });

  ws.station_tariffs.push({
    station_id: out.station.id_station_itinerance,
    payment_method_slug: 'cb_direct',
    tariff_id: tariffId,
    confidence: 'parsed',
    source_slug: out.hit.sourceSlug,
    parser_version: out.hit.parserVersion,
  });
}

function buildUrlRows(out: StationOutput, ws: WriteSet): void {
  if (out.hit.stage !== 'P3') return;
  ws.tariff_url_updates.push({
    station_id: out.station.id_station_itinerance,
    url: out.hit.parsed.url,
  });
}

// Build the parser_outcomes row (always — every station emits one)
function buildParserOutcome(out: StationOutput, ws: WriteSet): void {
  let outcome: ParserOutcomeRow['outcome'];
  let parsedJson: object | null;

  switch (out.hit.stage) {
    case 'P5':
      outcome = 'unknown';
      parsedJson = { matched_rule: out.hit.rule };
      break;
    case 'P0':
    case 'P1':
    case 'P2':
    case 'P3':
      outcome = 'success';
      parsedJson = out.hit.parsed as unknown as object;
      break;
    case 'NO_HIT':
      outcome = 'rejected';
      parsedJson = { reason: 'no parser matched the input across P5/P0/P1/P2/P3 chain' };
      break;
  }

  ws.parser_outcomes.push({
    source_slug: out.hit.sourceSlug,
    raw_input: out.station.tarification,
    raw_input_hash: out.rawInputHash,
    outcome,
    parsed_value_json: parsedJson,
    parser_version: out.hit.parserVersion,
  });
}

function buildAll(out: StationOutput, ws: WriteSet): void {
  buildParserOutcome(out, ws);
  buildDrivecoRows(out, ws);
  buildCiteosRows(out, ws);
  buildRegexKwhRows(out, ws);
  buildUrlRows(out, ws);
}

// ─── Bulk INSERT helpers (postgres-js syntax) ─────────────────────────

type SourceLookup = Map<string, string>;
type PaymentMethodLookup = Map<string, string>;

async function loadSourceLookup(sql: postgres.Sql): Promise<SourceLookup> {
  const rows = await sql<{ slug: string; id: string }[]>`
    SELECT slug, id FROM live.sources
  `;
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.slug, r.id);
  return map;
}

async function loadPaymentMethodLookup(sql: postgres.Sql): Promise<PaymentMethodLookup> {
  const rows = await sql<{ slug: string; id: string }[]>`
    SELECT slug, id FROM live.payment_methods
  `;
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.slug, r.id);
  return map;
}

async function ensureBootstrapRows(sql: postgres.Sql): Promise<void> {
  // Source row for ingestion_runs + NO_HIT parser_outcomes attribution.
  await sql`
    INSERT INTO live.sources (slug, kind, priority, display_name, description)
    VALUES (
      ${ORCHESTRATOR_SOURCE_SLUG},
      'parser',
      110,
      'Parser pipeline orchestrator (T13.2)',
      'Used as source for ingestion_runs row of tools/run-parsers/main.ts and for parser_outcomes rows when no parser matched (NO_HIT chain end). Created at runtime via INSERT ON CONFLICT. Parser-stage outcomes use their own slugs (sentinel_detector / driveco_irve_json / citeos_template_parser / regex_kwh_parser / url_extractor) seeded by migration 0005.'
    )
    ON CONFLICT (slug) DO NOTHING
  `;
  // Generic CB-direct payment_method (operator-agnostic). Existing
  // payment_methods seeded by 0003 are operator/product-specific
  // (electra-start, chargemap-pass, etc.). T13.2 needs a generic slug
  // for "direct CB payment at the station terminal" applicable across
  // all operators. Runtime INSERT preserves the no-new-migrations
  // discipline of W5; a future migration may consolidate.
  await sql`
    INSERT INTO live.payment_methods (slug, display_name, kind, description)
    VALUES (
      'cb_direct',
      'Carte bancaire (direct au terminal)',
      'cb_ad_hoc',
      'Operator-agnostic CB direct payment at the station terminal. T13.2 default for parser-extracted tariffs that do not specify a subscription/pass. Created at runtime via INSERT ON CONFLICT.'
    )
    ON CONFLICT (slug) DO NOTHING
  `;
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (!dbUrl) {
    console.error('FATAL: SUPABASE_DB_URL not set in env');
    return 2;
  }

  const sql = postgres(dbUrl, { prepare: false });
  console.log(`# parser orchestrator starting (version=${ORCHESTRATOR_VERSION}, dry_run=${dryRun})`);

  try {
    // Pre-run disk gate
    if (!dryRun) {
      const [{ size }] = await sql<{ size: number }[]>`SELECT pg_database_size(current_database())::bigint AS size`;
      const mb = Number(size) / 1024 / 1024;
      console.log(`# disk audit (pre-run): ${mb.toFixed(1)} MB`);
      if (Number(size) > DISK_GATE_BYTES) {
        throw new Error(`disk audit failed: ${mb.toFixed(1)} MB > ${DISK_GATE_BYTES / 1024 / 1024} MB threshold`);
      }
      await ensureBootstrapRows(sql);
    }

    // Load station inputs (only stations with content)
    const stations = await sql<StationInput[]>`
      SELECT id_station_itinerance, tarification
        FROM live.stations
       WHERE tarification IS NOT NULL AND btrim(tarification) != ''
    `;
    console.log(`# stations to process: ${stations.length}`);

    // Run chain per station, build write set
    const ws = emptyWriteSet();
    const stageCounts: Record<ChainHit['stage'], number> = {
      P5: 0, P0: 0, P1: 0, P2: 0, P3: 0, NO_HIT: 0,
    };

    for (const s of stations) {
      const hit = runChain(s.tarification);
      stageCounts[hit.stage] += 1;
      const out: StationOutput = {
        station: s,
        rawInputHash: sha256Hex(s.tarification),
        hit,
      };
      buildAll(out, ws);
    }

    // Print stage breakdown
    console.log('# chain breakdown:');
    for (const [stage, count] of Object.entries(stageCounts)) {
      console.log(`#   ${stage}: ${count}`);
    }
    console.log(`# write set:`);
    console.log(`#   tariffs:             ${ws.tariffs.length}`);
    console.log(`#   tariff_elements:     ${ws.tariff_elements.length}`);
    console.log(`#   price_components:    ${ws.price_components.length}`);
    console.log(`#   tariff_restrictions: ${ws.tariff_restrictions.length}`);
    console.log(`#   station_tariffs:     ${ws.station_tariffs.length}`);
    console.log(`#   parser_outcomes:     ${ws.parser_outcomes.length}`);
    console.log(`#   tariff_url_updates:  ${ws.tariff_url_updates.length}`);

    if (dryRun) {
      console.log('# DRY-RUN: skipped DB open + work tx + run close');
      await sql.end();
      return 0;
    }

    // Resolve source slugs → ids and payment_method slugs → ids
    const sourceLookup = await loadSourceLookup(sql);
    const pmLookup = await loadPaymentMethodLookup(sql);

    // Sanity check
    for (const slug of Object.values(SOURCE_SLUGS)) {
      if (!sourceLookup.has(slug)) {
        throw new Error(`source slug not found in live.sources: ${slug}`);
      }
    }
    if (!pmLookup.has('cb_direct')) {
      throw new Error(`payment_method slug 'cb_direct' not found in live.payment_methods`);
    }

    // Open ingestion_runs row OUTSIDE the work tx (visible on rollback)
    const orchestratorSourceId = sourceLookup.get(ORCHESTRATOR_SOURCE_SLUG)!;
    const gitSha = process.env.GIT_SHA ?? 'unknown';
    const [{ id: runId }] = await sql<{ id: string }[]>`
      INSERT INTO live.ingestion_runs (source_id, status, started_at, git_sha)
      VALUES (${orchestratorSourceId}, 'running', now(), ${gitSha})
      RETURNING id
    `;
    console.log(`# opened ingestion_runs.id=${runId}, status=running`);

    // Postgres protocol caps a parameterized statement at 65,535 bind
    // parameters (16-bit unsigned). For a 7-column INSERT, the per-call
    // ceiling is ~9,361 rows. We use a conservative 4,000-row chunk size
    // that fits any column count up to 16 (4,000 × 16 = 64,000 < 65,535)
    // — generous headroom against future schema additions.
    const CHUNK = 4000;
    function chunked<T>(arr: T[], size = CHUNK): T[][] {
      const chunks: T[][] = [];
      for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
      return chunks;
    }

    let workCommitted = false;
    try {
      // Bulk INSERT in FK dependency order (single transaction; chunked)
      await sql.begin(async (tx) => {
        if (ws.tariffs.length > 0) {
          const rows = ws.tariffs.map((t) => ({
            id: t.id,
            slug: t.slug,
            display_name: t.display_name,
            tariff_type: t.tariff_type,
            currency: t.currency,
            source_id: sourceLookup.get(t.source_slug)!,
          }));
          for (const chunk of chunked(rows)) {
            await tx`INSERT INTO live.tariffs ${tx(chunk, 'id', 'slug', 'display_name', 'tariff_type', 'currency', 'source_id')}`;
          }
        }
        if (ws.tariff_elements.length > 0) {
          for (const chunk of chunked(ws.tariff_elements)) {
            await tx`INSERT INTO live.tariff_elements ${tx(chunk, 'id', 'tariff_id', 'sequence_number')}`;
          }
        }
        if (ws.price_components.length > 0) {
          for (const chunk of chunked(ws.price_components)) {
            await tx`INSERT INTO live.price_components ${tx(chunk, 'tariff_element_id', 'type', 'price', 'step_size')}`;
          }
        }
        if (ws.tariff_restrictions.length > 0) {
          // Map nullable fields explicitly so postgres-js handles undefined → NULL
          const restrictionRows = ws.tariff_restrictions.map((r) => ({
            tariff_element_id: r.tariff_element_id,
            start_time: r.start_time ?? null,
            end_time: r.end_time ?? null,
            min_duration: r.min_duration ?? null,
            max_duration: r.max_duration ?? null,
          }));
          for (const chunk of chunked(restrictionRows)) {
            await tx`INSERT INTO live.tariff_restrictions ${tx(chunk, 'tariff_element_id', 'start_time', 'end_time', 'min_duration', 'max_duration')}`;
          }
        }
        if (ws.station_tariffs.length > 0) {
          const stRows = ws.station_tariffs.map((st) => ({
            station_id: st.station_id,
            payment_method_id: pmLookup.get(st.payment_method_slug)!,
            tariff_id: st.tariff_id,
            confidence: st.confidence,
            source_id: sourceLookup.get(st.source_slug)!,
            parser_version: st.parser_version,
          }));
          for (const chunk of chunked(stRows)) {
            await tx`INSERT INTO live.station_tariffs ${tx(chunk, 'station_id', 'payment_method_id', 'tariff_id', 'confidence', 'source_id', 'parser_version')}`;
          }
        }
        if (ws.parser_outcomes.length > 0) {
          // parser_outcomes is INPUT-grain not station-grain. The dedupe
          // UNIQUE on (raw_input_hash, source_id, parser_version) means
          // identical input texts (e.g. all 1,142 LIDL stations sharing
          // '0,29€/kWh') share a single outcome row by design. Collapse
          // before INSERT — saves 14k → ~150 rows AND respects the
          // schema's idempotence contract from 0007 D5.
          const dedupeMap = new Map<string, ParserOutcomeRow>();
          for (const po of ws.parser_outcomes) {
            const key = `${po.raw_input_hash}|${po.source_slug}|${po.parser_version}`;
            if (!dedupeMap.has(key)) dedupeMap.set(key, po);
          }
          const dedupedPoRows = Array.from(dedupeMap.values());
          console.log(`#   parser_outcomes (after input-hash dedupe): ${dedupedPoRows.length}`);
          const poRows = dedupedPoRows.map((po) => ({
            ingestion_run_id: runId,
            source_id: sourceLookup.get(po.source_slug)!,
            raw_input: po.raw_input,
            raw_input_hash: po.raw_input_hash,
            outcome: po.outcome,
            parsed_value_json: po.parsed_value_json,
            parser_version: po.parser_version,
          }));
          for (const chunk of chunked(poRows)) {
            await tx`INSERT INTO live.parser_outcomes ${tx(chunk, 'ingestion_run_id', 'source_id', 'raw_input', 'raw_input_hash', 'outcome', 'parsed_value_json', 'parser_version')}`;
          }
        }
        // tariff_url updates (P3 hits) — bulk UPDATE via VALUES
        if (ws.tariff_url_updates.length > 0) {
          await tx`
            UPDATE live.stations s
               SET tariff_url = v.url
              FROM (VALUES ${tx(ws.tariff_url_updates.map((u) => [u.station_id, u.url]))}) AS v(station_id, url)
             WHERE s.id_station_itinerance = v.station_id
          `;
        }
      });
      workCommitted = true;
      console.log(`# work tx committed`);

      // Close run as success
      await sql`
        UPDATE live.ingestion_runs SET
          status = 'success',
          finished_at = now(),
          rows_seen = ${stations.length},
          rows_inserted = ${ws.tariffs.length + ws.tariff_elements.length + ws.price_components.length + ws.tariff_restrictions.length + ws.station_tariffs.length + ws.parser_outcomes.length},
          rows_updated = ${ws.tariff_url_updates.length},
          rows_skipped = 0
        WHERE id = ${runId}
      `;
      console.log(`# ingestion_runs.id=${runId} closed status=success`);

      // Post-run disk gate (informational)
      const [{ size: sizeAfter }] = await sql<{ size: number }[]>`SELECT pg_database_size(current_database())::bigint AS size`;
      console.log(`# disk audit (post-run): ${(Number(sizeAfter) / 1024 / 1024).toFixed(1)} MB`);

      await sql.end();
      return 0;
    } catch (workErr) {
      // Work tx failed (or already rolled back); close run as failed
      const errMsg = workErr instanceof Error ? workErr.message : String(workErr);
      console.error(`# work failed: ${errMsg}`);
      try {
        await sql`
          UPDATE live.ingestion_runs SET
            status = 'failed',
            finished_at = now(),
            error_message = ${errMsg.slice(0, 5000)}
          WHERE id = ${runId}
        `;
        console.error(`# ingestion_runs.id=${runId} closed status=failed`);
      } catch (closeErr) {
        console.error(`# WARN: failed to close ingestion_runs row: ${closeErr}`);
      }
      await sql.end();
      return 1;
    }
  } catch (preErr) {
    console.error(`FATAL pre-run: ${preErr instanceof Error ? preErr.message : String(preErr)}`);
    await sql.end().catch(() => undefined);
    return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('environmental fault:', err);
    process.exit(2);
  });
