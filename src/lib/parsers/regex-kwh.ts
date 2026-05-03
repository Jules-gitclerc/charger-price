// P2 regex €/kWh parser — Prix-Bornes parser pipeline
//
// Pure function. No I/O. Catch-all for "0,29€/kWh" style strings
// across operators outside DRIVECO (P0) / CITEOS (P1) scope. 11,611
// of 224,467 PDC rows (5.2%) match the broad hallmark (€ OR cts near
// kwh) after P0/P1/P3/P5 exclusion as of 2026-05-02.
//
// PHASE 1 RECONCILIATION (audit-blind-spot pattern instance #9)
// -------------------------------------------------------------
// Phase 1 §D.1 framed PRICE_KWH_NL as ~8,351 rows around the €/kWh
// regex family. Pre-flight surfaced a parallel cts/kWh family of
// 3,265 rows missed entirely. Net hallmark volume +40%. The cts
// family includes major operators — Carrefour Energies (1,573),
// ALLEGO (1,173), Klépierre (172), Eiffage Energie Systèmes
// 24-agency network (~80) — not just the EVBOX outlier Phase 1
// named. Forward-practice: enumerate ALL unit symbols (€, cts, ct,
// EUR, euro, cents) before scoping a free-text price parser.
//
// CTS DISPOSITION (DC-T12-A — load-bearing)
// ------------------------------------------
//   Integer cts (≥ 1)   → centimes by industry convention.
//                         Extract as ENERGY at value × 0.01 €/kWh.
//                         Example: '36 cts/kWh' → 0.36 €/kWh.
//                         Per-element note records the interpretation.
//   Decimal cts (< 1)   → ambiguous between centimes (=value/100 €/kWh)
//                         and typo-€ (=value €/kWh). 100× spread; do
//                         not silently coerce. Drop element + push
//                         input-level warning. Observed operators:
//                         EVBOX, ZEENCO (~32 rows).
//
// HALLMARK BOUNDARY (DC-T12-E)
// ----------------------------
// This parser is reached AFTER P5/P0/P1/P3 in the orchestrator chain.
// FP guards in the smoke runner verify zero overlap with prior stages.
//
// MULTI-CLAUSE (DC-T12-B)
// -----------------------
// 229 rows in pre-flight encode multiple clauses (e.g.
// '0,35€/kWh + 0,05€/mn'). Output is RegexKwhElement[]; T13 dedupes /
// composes into OCPI tariff_elements.
//
// PREFIX CONTEXT (DC-T12-H)
// -------------------------
// Strings like 'AC 36cts/KWh', 'HPC 49cts/Kwh', 'Bornes normales :
// 0.41€ / kWh' carry connector-class metadata in the prefix. This
// parser captures the raw prefix label as `prefixContext`. T13 may
// translate to OCPI tariff_restrictions (min_power/max_power) using
// connector-class knowledge; this parser does NOT bake that mapping.
//
// SUBSCRIPTION MARKER (DC-T12-C)
// ------------------------------
// Patterns like 'pour les non abonnés' / 'adhérents' / 'membres'
// indicate the price is restricted by subscription. Captured as raw
// `subscriptionMarker` text. T13 resolves to subscription_id via
// alias lookup or leaves NULL.
//
// TIME RESTRICTIONS (DC-T12-I)
// ----------------------------
// Time-window phrases ('entre 6h et 18h') observed in some multi-clause
// rows are NOT extracted in v1; surfaced as an informational note when
// detected. Deferred to regex-kwh-v2 if T13 / T15 demand it.
//
// CURRENCY (DC-T12-D)
// -------------------
// € only. Other currencies not observed in pre-flight; mojibake (€ →
// 'â‚¬') falls through to no-hallmark and is not handled.
//
// T13 RESPONSIBILITIES (downstream consumer guidance)
// ---------------------------------------------------
// - Subscription resolution (subscriptionMarker → subscription_id alias)
// - Connector-class mapping (prefixContext 'AC' / 'HPC' / 'DC' →
//   tariff_restrictions.min_power / max_power)
// - Multi-clause dedupe / composition into OCPI tariff_elements
// - Time-window restriction extraction if needed (drives v2)
//
// PARSER VERSIONING
// -----------------
// `<parser-slug-without-underscore>-v<integer>`. Bump on any behavior
// change.

import { round4 } from './_units';

export const PARSER_VERSION = 'regex-kwh-v1' as const;

// ────────────────────────────────────────────────────────────────────
// Hallmark pre-checks (cheap; called once per input)
// ────────────────────────────────────────────────────────────────────

const HALLMARK_EUR = /€\s*[/\s.]{0,5}[kK][wW][hH]/;
const HALLMARK_CTS = /\d\s*cts?\s*[/\s.]{0,5}[kK][wW][hH]/i;

// ────────────────────────────────────────────────────────────────────
// Extraction patterns. All use `g` flag for replace-with-callback.
// Decimal separator: parser normalizes '.' and ',' via parseFloat after
// substitution.
// ────────────────────────────────────────────────────────────────────

const NUM = '(\\d+(?:[.,]\\d+)?)';
const KWH = '[kK][wW][hH]';

const RX_ENERGY_EUR = new RegExp(
  `${NUM}\\s*€(?:\\s*HT|\\s*TTC)?\\s*[/\\s.]*\\s*${KWH}`,
  'g',
);
const RX_ENERGY_CTS = new RegExp(
  `${NUM}\\s*cts?(?:\\s*HT|\\s*TTC)?\\s*[/\\s.]*\\s*${KWH}`,
  'gi',
);
// Time per-minute: variants min, mn, minute, minutes.
const RX_TIME_EUR_MIN = new RegExp(
  `${NUM}\\s*€\\s*/?\\s*(?:minutes?|min|mn)\\b`,
  'gi',
);
// Time per-hour: variants h (with non-letter follower), heure, hour.
const RX_TIME_EUR_HOUR = new RegExp(
  `${NUM}\\s*€\\s*/?\\s*(?:heure|hour|h(?![a-zA-Z]))`,
  'gi',
);
// Flat session: explicit 'session' or 'forfait' marker required.
// Bare-€-with-+ patterns (e.g. '2€ + 0.59€/kWh') are NOT extracted as
// FLAT in v1 — surface as informational note instead.
const RX_FLAT_SESSION = new RegExp(
  `${NUM}\\s*€\\s+(?:la\\s+)?(?:session|forfait)`,
  'gi',
);

// Prefix context — scan once at start of input.
const RX_PREFIX = /^\s*(AC|HPC|DC|Bornes\s+normales|Bornes\s+rapides|Coût\s+de\s+l['’]énergie)\b[^0-9]*/i;

// Subscription marker.
const RX_SUBSCRIPTION =
  /(pour\s+(?:les\s+)?(?:non\s+)?abonn[ée]e?s?|adh[ée]rents?\b|membres?\b|clients?\b)/i;

// Time-window phrase (informational only in v1).
const RX_TIME_WINDOW_INFO =
  /entre\s+\d{1,2}\s*h\s*\d{0,2}\s+et\s+\d{1,2}\s*h\s*\d{0,2}/i;

const TIME_WINDOW_NOTE =
  'informational: time-window phrase observed in input but not parsed; ' +
  'deferred to regex-kwh-v2.';

// ────────────────────────────────────────────────────────────────────
// Output types
// ────────────────────────────────────────────────────────────────────

export type RegexKwhSourceClause =
  | 'energy_eur_per_kwh'
  | 'energy_cts_integer'
  | 'time_eur_per_min'
  | 'time_eur_per_hour'
  | 'flat_session';

export type RegexKwhDimension = 'ENERGY' | 'TIME' | 'FLAT';
export type RegexKwhUnit =
  | 'eur_per_kwh'
  | 'eur_per_hour'
  | 'eur_per_session';

export type RegexKwhElement = {
  dimension: RegexKwhDimension;
  pricePerUnitEur: number;
  unit: RegexKwhUnit;
  sourceClause: RegexKwhSourceClause;
  notes: string[];
};

export type RegexKwhParsed = {
  shape: 'regex-kwh-v1';
  elements: RegexKwhElement[];
  prefixContext: string | null;
  subscriptionMarker: string | null;
  notes: string[];
  warnings: string[];
};

export type RegexKwhResult =
  | { ok: true; parsed: RegexKwhParsed }
  | { ok: false; outcome: 'error' | 'rejected'; reason: string };

// ────────────────────────────────────────────────────────────────────
// Numeric helpers (decimal separator normalization + cts disambiguation)
// ────────────────────────────────────────────────────────────────────

function parseLocaleNumber(raw: string): number {
  return parseFloat(raw.replace(',', '.'));
}

function centimesNote(value: number): string {
  return (
    `interpreted from centimes: input '${value} cts/kWh' → ` +
    `${round4(value * 0.01)} €/kWh by industry convention`
  );
}

function decimalCtsWarning(value: number): string {
  return (
    `decimal cts value <1 detected (${value}); ambiguous between centimes ` +
    `(=${round4(value / 100)} €/kWh) and typo-€ (=${value} €/kWh). Element ` +
    'not extracted. Operators observed: EVBOX, ZEENCO.'
  );
}

// ────────────────────────────────────────────────────────────────────
// Main parser
// ────────────────────────────────────────────────────────────────────

export function parseRegexKwh(input: string): RegexKwhResult {
  // 1. Hallmark pre-check.
  if (!HALLMARK_EUR.test(input) && !HALLMARK_CTS.test(input)) {
    return { ok: false, outcome: 'rejected', reason: 'no €/cts hallmark' };
  }

  const elements: RegexKwhElement[] = [];
  const notes: string[] = [];
  const warnings: string[] = [];

  // 2. Prefix context — scan original input.
  let prefixContext: string | null = null;
  const prefixMatch = input.match(RX_PREFIX);
  if (prefixMatch) {
    // Normalize internal whitespace (e.g. 'Bornes  normales' → 'Bornes normales').
    prefixContext = prefixMatch[1].replace(/\s+/g, ' ').trim();
  }

  // 3. Subscription marker.
  let subscriptionMarker: string | null = null;
  const subMatch = input.match(RX_SUBSCRIPTION);
  if (subMatch) {
    subscriptionMarker = subMatch[1].trim();
  }

  // 4. Time-window informational note.
  if (RX_TIME_WINDOW_INFO.test(input)) {
    notes.push(TIME_WINDOW_NOTE);
  }

  // 5. Sequential extract-and-strip. Each spec replaces its matches
  // with a space placeholder before the next spec runs. This prevents
  // accidental cross-pattern overlap if a future regex broadens.
  let working = input;

  // 5a. ENERGY €/kWh.
  working = working.replace(RX_ENERGY_EUR, (_, priceStr: string) => {
    elements.push({
      dimension: 'ENERGY',
      pricePerUnitEur: round4(parseLocaleNumber(priceStr)),
      unit: 'eur_per_kwh',
      sourceClause: 'energy_eur_per_kwh',
      notes: [],
    });
    return ' ';
  });

  // 5b. ENERGY cts/kWh — integer ≥ 1 = centimes; decimal < 1 = ambiguous.
  working = working.replace(RX_ENERGY_CTS, (_, priceStr: string) => {
    const raw = parseLocaleNumber(priceStr);
    if (raw < 1) {
      // Ambiguous decimal. Drop element, push input-level warning.
      warnings.push(decimalCtsWarning(raw));
      return ' ';
    }
    // Integer-ish (≥ 1) — interpret as centimes.
    elements.push({
      dimension: 'ENERGY',
      pricePerUnitEur: round4(raw * 0.01),
      unit: 'eur_per_kwh',
      sourceClause: 'energy_cts_integer',
      notes: [centimesNote(raw)],
    });
    return ' ';
  });

  // 5c. TIME €/min — convert to €/hr (× 60).
  working = working.replace(RX_TIME_EUR_MIN, (_, priceStr: string) => {
    const raw = parseLocaleNumber(priceStr);
    elements.push({
      dimension: 'TIME',
      pricePerUnitEur: round4(raw * 60),
      unit: 'eur_per_hour',
      sourceClause: 'time_eur_per_min',
      notes: [],
    });
    return ' ';
  });

  // 5d. TIME €/h.
  working = working.replace(RX_TIME_EUR_HOUR, (_, priceStr: string) => {
    elements.push({
      dimension: 'TIME',
      pricePerUnitEur: round4(parseLocaleNumber(priceStr)),
      unit: 'eur_per_hour',
      sourceClause: 'time_eur_per_hour',
      notes: [],
    });
    return ' ';
  });

  // 5e. FLAT session. Last spec — the strip output is no longer used,
  // but the replace iterates all matches via the callback for side
  // effect (push to elements). Don't reassign `working`.
  working.replace(RX_FLAT_SESSION, (_, priceStr: string) => {
    elements.push({
      dimension: 'FLAT',
      pricePerUnitEur: round4(parseLocaleNumber(priceStr)),
      unit: 'eur_per_session',
      sourceClause: 'flat_session',
      notes: [],
    });
    return ' ';
  });

  // 6. Reject if nothing extracted (hallmark matched but all clauses
  // missed or were dropped). Pre-flight baseline: small, mostly the
  // decimal-cts-only cases like '0,30cts/KWh'.
  if (elements.length === 0) {
    return {
      ok: false,
      outcome: 'rejected',
      reason: 'hallmark matched but no atomic clauses extracted',
    };
  }

  return {
    ok: true,
    parsed: {
      shape: 'regex-kwh-v1',
      elements,
      prefixContext,
      subscriptionMarker,
      notes,
      warnings,
    },
  };
}
