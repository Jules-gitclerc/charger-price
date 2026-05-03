// P5 sentinel detector — Prix-Bornes parser pipeline
//
// Pure function. No I/O. Decides whether a raw IRVE `tarification`
// value carries no extractable price (and downstream parsers should
// not bother trying).
//
// Per W5 hard rule + design summary: when the orchestrator (T13) calls
// this and gets a sentinel result, it writes ONE row to
// live.parser_outcomes (source=sentinel_detector, outcome='unknown')
// and NO row to live.station_tariffs. Absence of a station_tariffs
// row is the "tarif non communiqué" state in the viewer.
//
// PARSER VERSIONING CONVENTION
// ----------------------------
// `<parser-slug-without-underscore>-v<integer>`. Bump on ANY behavior
// change (new rule, threshold change, regex modification, whitelist
// addition). No semver — parsers don't have a meaningful patch/minor
// distinction; the only question is "did behavior change?". Convention
// shared across all P-stage parsers.
//
// R4 WHITELIST EXPANSION CRITERIA
// -------------------------------
// Additions require evidence of ≥100 occurrences in live data + manual
// review confirming the value carries no extractable price/url. Bias
// toward false-negative (let downstream parsers try, possibly drop
// silently) over false-positive (silently skip parseable input). The
// asymmetry of cost favors conservatism: a dropped non-sentinel input
// just means no station_tariffs row, which the viewer renders as
// "tarif non communiqué" — same as if R4 fired correctly. A
// false-positive means we never even attempt to parse a string the
// downstream pipeline might have handled.

export const PARSER_VERSION = 'sentinel-v1' as const;

export type SentinelRule =
  | 'R1_empty'
  | 'R2_dash'
  | 'R3_bool_string'
  | 'R4_short_no_digits'
  | 'R5_negation_phrases'
  | 'R6_powerdot_prefix';

export type SentinelResult =
  | { isSentinel: true; rule: SentinelRule; matchedAgainst: string }
  | { isSentinel: false };

// R4 — conservative whitelist of short prose markers (≤ 8 chars, no
// digits). Lowercase keys; lookup is via input.trim().toLowerCase().
// Phase 1 §D.2 + §D.3 sourced. Expansion criteria documented above.
const R4_WHITELIST: ReadonlySet<string> = new Set([
  'inconnu',
  'n/a',
  '/',
  'fixe',
  'au kwh',
  'aucune',
  'nc',
  'none',
  'null',
]);

// R5 — substring negation phrases. Case-insensitive. The operator
// stated absence of price (in French). Match anywhere in the value.
const R5_PHRASES: readonly string[] = [
  'non concerné',
  'non communiqué',
  'à venir',
  'sans tarif',
];

// R6 — Power Dot meta-disclaimer prefix. Case-sensitive, anchored at
// start (trailing content varies; do NOT use full-text equality).
// Phase 1 §D.3: 12,890 rows of an identical or near-identical disclaimer.
const R6_POWERDOT_PREFIX = 'Les tarifs de recharge peuvent varier';

export function detectSentinel(input: string): SentinelResult {
  const normalized = input.trim();

  // R1 — empty / whitespace-only. ~75% of the corpus.
  if (normalized.length === 0) {
    return { isSentinel: true, rule: 'R1_empty', matchedAgainst: '' };
  }

  // R2 — explicit dash placeholder.
  if (normalized === '-') {
    return { isSentinel: true, rule: 'R2_dash', matchedAgainst: '-' };
  }

  const lower = normalized.toLowerCase();

  // R3 — boolean string leaked from another schema field.
  if (lower === 'true' || lower === 'false') {
    return { isSentinel: true, rule: 'R3_bool_string', matchedAgainst: lower };
  }

  // R4 — short whitelist match. Length and no-digit guards keep the
  // whitelist safe even if a future addition would otherwise overshoot.
  if (normalized.length <= 8 && !/\d/.test(normalized) && R4_WHITELIST.has(lower)) {
    return { isSentinel: true, rule: 'R4_short_no_digits', matchedAgainst: lower };
  }

  // R5 — substring negation phrases.
  for (const phrase of R5_PHRASES) {
    if (lower.includes(phrase)) {
      return { isSentinel: true, rule: 'R5_negation_phrases', matchedAgainst: phrase };
    }
  }

  // R6 — Power Dot prefix.
  if (normalized.startsWith(R6_POWERDOT_PREFIX)) {
    return {
      isSentinel: true,
      rule: 'R6_powerdot_prefix',
      matchedAgainst: R6_POWERDOT_PREFIX,
    };
  }

  return { isSentinel: false };
}
