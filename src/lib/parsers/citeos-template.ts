// P1 CITEOS template parser — Prix-Bornes parser pipeline
//
// Pure function. No I/O. Extracts atomic clauses from the templated
// French free-text emitted by the CITEOS-supplied tariff software.
// 12,020 of 224,467 PDC rows (5.4%) carry this shape as of 2026-05-02.
//
// MULTI-OPERATOR SCOPE (audit-blind-spot pattern instance #8)
// -----------------------------------------------------------
// Phase 1 attributed this template to the "CPO CITEOS" enseigne family
// only. Reality: 11 enseignes use it — CITEOS variants (4,940 + 1,382 +
// 404 + 345 + 66 + 10 + 7 = 7,154), eborn (3,443), Easy Charge Services
// (1,306), AVIA VOLT variants (85 + 32 = 117). The template is the
// shared underlying software, not the operator's brand. This parser
// matches on template signature ONLY — no enseigne filter.
//
// CLAUSE TAXONOMY (10 atomic types + 1 corruption variant)
// --------------------------------------------------------
// time_window_energy        "entre H1 et H2 : P€ par kwh de charge"
// time_window_parking_off   "entre H1 et H2 : P€ par heure d'occupation hors charge"
// time_window_charging_time "entre H1 et H2 : P€ par heure de charge"
// time_window_start_fee     "entre H1 et H2 : prix de départ P€"
// default_energy            "par défaut : P€ par kwh de charge"
// default_parking_off       "par défaut : P€ par heure d'occupation hors charge"
// default_start_fee         "par défaut : prix de départ P€"
// bare_energy               "P€ par kwh de charge"          (no prefix)
// bare_parking_off          "P€ par heure d'occupation hors charge"  (no prefix)
// bare_charging_time        "P€ par heure de charge"        (no prefix)
// comma_bug_parking         "par heure ,'occupation"        (1 row in corpus, repaired)
//
// EXTRACTION ORDER
// ----------------
// More-specific patterns are extracted FIRST and replaced with a space
// placeholder before the next pass. This prevents bare_X regexes from
// double-matching the trailing portion of time_window_X / default_X
// clauses (which contain the same suffix).
//
// COMMA-BUG REPAIR (discipline observation #4 applied at parse time)
// -------------------------------------------------------------------
// Single observed corruption pattern (FRS84EVCAXI1, CPO CITEOS Vaucluse):
// `par heure ,'occupation` instead of `par heure d'occupation`. Repair
// before extraction; emit warning so parser_outcomes records the issue.
// Tolerate input bugs, don't reject. Surface in audit trail.
//
// T13 DEDUPE CONTRACT (downstream consumer guidance)
// --------------------------------------------------
// This parser emits every clause as a separate CiteosElement, faithful
// to input. T13 (orchestrator) is responsible for collapsing redundant
// elements when writing OCPI rows:
//   - bare_X + default_X with same price → emit ONE tariff_element
//     (semantic equivalents — both mean "applies by default").
//   - bare_X + time_window_X clauses cumulatively covering 24h → bare
//     is redundant; emit only the time_window elements.
//   - default_X + time_window_X with same price covering 24h →
//     equivalent; T13 picks one.
//   - default_X + time_window_X with DIFFERENT prices → default is
//     the gap-filler (price for hours not covered by any window);
//     keep both, restrictions disambiguate at OCPI evaluation.
//
// Multi-price warnings (multiple distinct prices for the same
// dimension + restriction-shape) are passed through. T13 must apply
// operator/connector knowledge to disambiguate (likely connector-
// specific rates — see FRBFCEVDIJZ1 example).
//
// FAILURE MODES
// -------------
// 'rejected' — input lacks the CITEOS hallmark (cheap pre-check), OR
//              hallmark matches but no atomic clause extracts (would
//              signal a shape variant; baseline = 0 in current corpus).
// 'error'    — kept in the type for symmetry with T10/T13 orchestrator;
//              not naturally reachable for this regex-only parser.
//
// PARSER VERSIONING
// -----------------
// `<parser-slug-without-underscore>-v<integer>`. Bump on any behavior
// change (new clause type, regex modification, repair-rule addition).

import { round4 } from './_units';

export const PARSER_VERSION = 'citeos-template-v1' as const;

// Cheap pre-check — short-circuits the orchestrator's chain in T13.
// Matches if the input contains any of the four hallmark phrases.
const HALLMARK_REGEX =
  /par kwh de charge|par heure d['’]occupation|par heure de charge|par défaut\s*:/i;

// The single observed comma-bug repair pattern (1 row: FRS84EVCAXI1).
const COMMA_BUG_REGEX = /par heure\s*,\s*['’]occupation/g;
const COMMA_BUG_REPAIR = "par heure d'occupation";
const COMMA_BUG_NOTE =
  "upstream stringification artifact detected ('par heure ,\\'occupation'); " +
  "repaired to 'par heure d\\'occupation' before extraction. Source: " +
  'FRS84EVCAXI1-class rows in CPO CITEOS Vaucluse (1 occurrence in 12,020 ' +
  'CITEOS-template rows as of parser-version=citeos-template-v1).';

// HH:MM time pattern — strict (H ∈ 0-23, M ∈ 0-59). Used inside the
// time-window regexes so malformed times fall through to no-match.
const HHMM = '(?:[01]\\d|2[0-3]):[0-5]\\d';
const PRICE = '(\\d+(?:\\.\\d+)?)';

// More-specific (time-window + default) patterns are extracted before
// bare patterns. The 'g' flag is required for replace-with-callback.
const RX_TIME_WINDOW_ENERGY = new RegExp(
  `entre\\s+(${HHMM})\\s+et\\s+(${HHMM})\\s*:\\s*${PRICE}€\\s+par kwh de charge`,
  'gi',
);
const RX_TIME_WINDOW_PARKING_OFF = new RegExp(
  `entre\\s+(${HHMM})\\s+et\\s+(${HHMM})\\s*:\\s*${PRICE}€\\s+par heure d['’]occupation hors charge`,
  'gi',
);
const RX_TIME_WINDOW_CHARGING_TIME = new RegExp(
  `entre\\s+(${HHMM})\\s+et\\s+(${HHMM})\\s*:\\s*${PRICE}€\\s+par heure de charge`,
  'gi',
);
const RX_TIME_WINDOW_START_FEE = new RegExp(
  `entre\\s+(${HHMM})\\s+et\\s+(${HHMM})\\s*:\\s*prix de départ\\s+${PRICE}€`,
  'gi',
);
const RX_DEFAULT_ENERGY = new RegExp(
  `par défaut\\s*:\\s*${PRICE}€\\s+par kwh de charge`,
  'gi',
);
const RX_DEFAULT_PARKING_OFF = new RegExp(
  `par défaut\\s*:\\s*${PRICE}€\\s+par heure d['’]occupation hors charge`,
  'gi',
);
const RX_DEFAULT_START_FEE = new RegExp(
  `par défaut\\s*:\\s*prix de départ\\s+${PRICE}€`,
  'gi',
);
const RX_BARE_ENERGY = new RegExp(`${PRICE}€\\s+par kwh de charge`, 'gi');
const RX_BARE_PARKING_OFF = new RegExp(
  `${PRICE}€\\s+par heure d['’]occupation hors charge`,
  'gi',
);
const RX_BARE_CHARGING_TIME = new RegExp(
  `${PRICE}€\\s+par heure de charge`,
  'gi',
);

export type CiteosTime = { startLocal: string; endLocal: string };

export type CiteosSourceClause =
  | 'bare_energy'
  | 'time_window_energy'
  | 'default_energy'
  | 'bare_parking_off'
  | 'time_window_parking_off'
  | 'default_parking_off'
  | 'bare_charging_time'
  | 'time_window_charging_time'
  | 'default_start_fee'
  | 'time_window_start_fee';

export type CiteosUnit =
  | 'eur_per_kwh'
  | 'eur_per_hour'
  | 'eur_per_session';

export type CiteosDimension = 'ENERGY' | 'PARKING_TIME' | 'TIME' | 'FLAT';

export type CiteosElement = {
  dimension: CiteosDimension;
  pricePerUnitEur: number;
  unit: CiteosUnit;
  restriction: CiteosTime | null;
  sourceClause: CiteosSourceClause;
};

export type CiteosTemplateParsed = {
  shape: 'citeos-template-v1';
  elements: CiteosElement[];
  notes: string[];
  warnings: string[];
};

export type CiteosTemplateResult =
  | { ok: true; parsed: CiteosTemplateParsed }
  | { ok: false; outcome: 'error' | 'rejected'; reason: string };

type ClauseSpec = {
  regex: RegExp;
  sourceClause: CiteosSourceClause;
  dimension: CiteosDimension;
  unit: CiteosUnit;
  hasTimeWindow: boolean;
};

// Extraction order: time-window → default → bare. Within each group,
// parking_off / charging_time / start_fee come before energy because
// their phrases are more-specific (longer, distinct trailing tokens).
const CLAUSE_SPECS: readonly ClauseSpec[] = [
  { regex: RX_TIME_WINDOW_PARKING_OFF, sourceClause: 'time_window_parking_off', dimension: 'PARKING_TIME', unit: 'eur_per_hour', hasTimeWindow: true },
  { regex: RX_TIME_WINDOW_CHARGING_TIME, sourceClause: 'time_window_charging_time', dimension: 'TIME', unit: 'eur_per_hour', hasTimeWindow: true },
  { regex: RX_TIME_WINDOW_START_FEE, sourceClause: 'time_window_start_fee', dimension: 'FLAT', unit: 'eur_per_session', hasTimeWindow: true },
  { regex: RX_TIME_WINDOW_ENERGY, sourceClause: 'time_window_energy', dimension: 'ENERGY', unit: 'eur_per_kwh', hasTimeWindow: true },
  { regex: RX_DEFAULT_PARKING_OFF, sourceClause: 'default_parking_off', dimension: 'PARKING_TIME', unit: 'eur_per_hour', hasTimeWindow: false },
  { regex: RX_DEFAULT_START_FEE, sourceClause: 'default_start_fee', dimension: 'FLAT', unit: 'eur_per_session', hasTimeWindow: false },
  { regex: RX_DEFAULT_ENERGY, sourceClause: 'default_energy', dimension: 'ENERGY', unit: 'eur_per_kwh', hasTimeWindow: false },
  { regex: RX_BARE_PARKING_OFF, sourceClause: 'bare_parking_off', dimension: 'PARKING_TIME', unit: 'eur_per_hour', hasTimeWindow: false },
  { regex: RX_BARE_CHARGING_TIME, sourceClause: 'bare_charging_time', dimension: 'TIME', unit: 'eur_per_hour', hasTimeWindow: false },
  { regex: RX_BARE_ENERGY, sourceClause: 'bare_energy', dimension: 'ENERGY', unit: 'eur_per_kwh', hasTimeWindow: false },
];

function priceForUnit(unit: CiteosUnit, raw: number): number {
  // ENERGY prices need round4 (input precision often exceeds 4 dp,
  // e.g. 0.30916667 → 0.3092). Hour and session prices in current data
  // are already at ≤2 dp; round4 still applied defensively for symmetry.
  return unit === 'eur_per_kwh' || unit === 'eur_per_hour' || unit === 'eur_per_session'
    ? round4(raw)
    : raw;
}

function multiPriceWarning(
  dimension: CiteosDimension,
  restrictionLabel: string,
  prices: readonly number[],
): string {
  return (
    `multiple distinct prices for dimension=${dimension} at ${restrictionLabel} grain: ` +
    `[${prices.join(', ')}]. Parser emits both elements; downstream consumer must ` +
    'disambiguate (likely connector-specific rates).'
  );
}

function restrictionLabel(r: CiteosTime | null): string {
  return r ? `time-window ${r.startLocal}-${r.endLocal}` : 'no-restriction';
}

export function parseCiteosTemplate(input: string): CiteosTemplateResult {
  // 1. Cheap hallmark pre-check.
  if (!HALLMARK_REGEX.test(input)) {
    return { ok: false, outcome: 'rejected', reason: 'no CITEOS hallmark' };
  }

  // 2. Comma-bug repair. Test-via-replace to avoid the `g`-flag
  // RegExp.lastIndex pitfall (test() on a g-flagged regex mutates
  // lastIndex and breaks repeatable matching). If the replace changed
  // the string, the bug was present.
  const warnings: string[] = [];
  const repaired = input.replace(COMMA_BUG_REGEX, COMMA_BUG_REPAIR);
  let working = repaired;
  if (repaired !== input) {
    warnings.push(COMMA_BUG_NOTE);
  }

  // 3. Sequential extraction. Each spec strips its matches from the
  // working string before the next spec runs, preventing bare_X from
  // double-matching the suffix of time_window_X / default_X clauses.
  const elements: CiteosElement[] = [];
  for (const spec of CLAUSE_SPECS) {
    working = working.replace(spec.regex, (...args: unknown[]) => {
      // For time-window patterns: groups are [h1, h2, price]. For
      // others: [price]. Captures are positions 1..n in the args array
      // (position 0 is the full match).
      if (spec.hasTimeWindow) {
        const startLocal = args[1] as string;
        const endLocal = args[2] as string;
        const priceStr = args[3] as string;
        elements.push({
          dimension: spec.dimension,
          pricePerUnitEur: priceForUnit(spec.unit, parseFloat(priceStr)),
          unit: spec.unit,
          restriction: { startLocal, endLocal },
          sourceClause: spec.sourceClause,
        });
      } else {
        const priceStr = args[1] as string;
        elements.push({
          dimension: spec.dimension,
          pricePerUnitEur: priceForUnit(spec.unit, parseFloat(priceStr)),
          unit: spec.unit,
          restriction: null,
          sourceClause: spec.sourceClause,
        });
      }
      return ' ';
    });
  }

  // 4. Reject if hallmark matched but no atomic clause extracted.
  // Pre-flight baseline: 0 occurrences in 12,020 corpus rows.
  if (elements.length === 0) {
    return {
      ok: false,
      outcome: 'rejected',
      reason: 'hallmark matched but no atomic clauses extracted',
    };
  }

  // 5. Multi-price detection. Group by (dimension, restriction-shape);
  // emit a warning per group with ≥2 distinct prices.
  const groups = new Map<string, { dimension: CiteosDimension; restriction: CiteosTime | null; prices: Set<number> }>();
  for (const el of elements) {
    const key = `${el.dimension}|${restrictionLabel(el.restriction)}`;
    const g = groups.get(key);
    if (g) {
      g.prices.add(el.pricePerUnitEur);
    } else {
      groups.set(key, {
        dimension: el.dimension,
        restriction: el.restriction,
        prices: new Set([el.pricePerUnitEur]),
      });
    }
  }
  for (const g of groups.values()) {
    if (g.prices.size >= 2) {
      const sorted = Array.from(g.prices).sort((a, b) => b - a);
      warnings.push(
        multiPriceWarning(g.dimension, restrictionLabel(g.restriction), sorted),
      );
    }
  }

  return {
    ok: true,
    parsed: {
      shape: 'citeos-template-v1',
      elements,
      notes: [],
      warnings,
    },
  };
}
