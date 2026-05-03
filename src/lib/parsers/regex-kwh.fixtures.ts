// Fixtures for the P2 regex €/kWh parser.
//
// SUCCESS fixtures: cover each clause type, the cts disambiguation
// boundary (integer ≥1 vs decimal <1), prefix context, subscription
// marker, multi-clause, and the F-edenauto verbatim-from-CSV row that
// proves robustness against upstream typos ('voitutre' for 'voiture').
//
// NON_SUCCESS fixtures: cover no-hallmark + hallmark-but-no-clauses
// boundaries.

import type {
  RegexKwhParsed,
  RegexKwhElement,
  RegexKwhDimension,
  RegexKwhUnit,
  RegexKwhSourceClause,
} from './regex-kwh';

export type RegexKwhSuccessFixture = {
  syntheticId: string;
  rawInput: string;
  expectedParsed: RegexKwhParsed;
  manualHandDerivation: string;
};

export type RegexKwhNonSuccessFixture = {
  label: string;
  rawInput: string;
  expectedOutcome: 'error' | 'rejected';
  expectedReasonContains?: string;
};

// Helpers — keep fixture declarations terse and reviewable.
const elem = (
  dimension: RegexKwhDimension,
  pricePerUnitEur: number,
  unit: RegexKwhUnit,
  sourceClause: RegexKwhSourceClause,
  notes: string[] = [],
): RegexKwhElement => ({ dimension, pricePerUnitEur, unit, sourceClause, notes });

const centimesNote = (value: number, perKwh: number): string =>
  `interpreted from centimes: input '${value} cts/kWh' → ${perKwh} €/kWh by industry convention`;

// (decimalCtsWarning helper omitted — the warning text appears only
// inside the parser's runtime path; fixtures assert via substring
// matching on `result.warnings[0]` in the test file.)

const TIME_WINDOW_NOTE =
  'informational: time-window phrase observed in input but not parsed; ' +
  'deferred to regex-kwh-v2.';

export const REGEX_KWH_SUCCESS_FIXTURES: readonly RegexKwhSuccessFixture[] = [
  // ── F1: simplest LIDL pattern (3,569-row top-frequency) ───────────
  {
    syntheticId: 'FRREGEX_FIXTURE_F1_LIDL_BASIC',
    rawInput: '0,29€ / kWh',
    expectedParsed: {
      shape: 'regex-kwh-v1',
      elements: [elem('ENERGY', 0.29, 'eur_per_kwh', 'energy_eur_per_kwh')],
      prefixContext: null,
      subscriptionMarker: null,
      notes: [],
      warnings: [],
    },
    manualHandDerivation:
      'LIDL top-frequency value (3,569 rows in CSV). Comma decimal normalized to 0.29. 1 ENERGY element.',
  },

  // ── F2: R3 no-spaces variant (521 rows) ───────────────────────────
  {
    syntheticId: 'FRREGEX_FIXTURE_F2_R3_NOSPACES',
    rawInput: '0.55€/kWh',
    expectedParsed: {
      shape: 'regex-kwh-v1',
      elements: [elem('ENERGY', 0.55, 'eur_per_kwh', 'energy_eur_per_kwh')],
      prefixContext: null,
      subscriptionMarker: null,
      notes: [],
      warnings: [],
    },
    manualHandDerivation:
      'R3 (521 rows in CSV). Dot decimal, no spaces. 1 ENERGY element.',
  },

  // ── F3: integer cts (ALLEGO/GreenToWheel, 679-row pattern) ────────
  {
    syntheticId: 'FRREGEX_FIXTURE_F3_INTEGER_CTS',
    rawInput: '59 cts/kWh',
    expectedParsed: {
      shape: 'regex-kwh-v1',
      elements: [
        elem('ENERGY', 0.59, 'eur_per_kwh', 'energy_cts_integer', [
          centimesNote(59, 0.59),
        ]),
      ],
      prefixContext: null,
      subscriptionMarker: null,
      notes: [],
      warnings: [],
    },
    manualHandDerivation:
      '59 cts × 0.01 = 0.59 €/kWh. Industry convention (HPC fast-charge rate). 679 rows in CSV.',
  },

  // ── F4: AC prefix + integer cts (Klépierre/Carrefour, 746 rows) ───
  {
    syntheticId: 'FRREGEX_FIXTURE_F4_AC_PREFIX_CTS',
    rawInput: 'AC 36cts/KWh',
    expectedParsed: {
      shape: 'regex-kwh-v1',
      elements: [
        elem('ENERGY', 0.36, 'eur_per_kwh', 'energy_cts_integer', [
          centimesNote(36, 0.36),
        ]),
      ],
      prefixContext: 'AC',
      subscriptionMarker: null,
      notes: [],
      warnings: [],
    },
    manualHandDerivation:
      'AC prefix → Klépierre/Carrefour AC connector class. 36 cts × 0.01 = 0.36 €/kWh. 746 rows in CSV.',
  },

  // ── F5: HPC prefix + integer cts (Carrefour, 386 rows) ────────────
  {
    syntheticId: 'FRREGEX_FIXTURE_F5_HPC_PREFIX_CTS',
    rawInput: 'HPC 59cts/Kwh',
    expectedParsed: {
      shape: 'regex-kwh-v1',
      elements: [
        elem('ENERGY', 0.59, 'eur_per_kwh', 'energy_cts_integer', [
          centimesNote(59, 0.59),
        ]),
      ],
      prefixContext: 'HPC',
      subscriptionMarker: null,
      notes: [],
      warnings: [],
    },
    manualHandDerivation:
      'HPC prefix → high-power connector class (≥ 50 kW). 386 rows in CSV.',
  },

  // ── F6: text prefix 'Bornes normales' (174 rows) ──────────────────
  {
    syntheticId: 'FRREGEX_FIXTURE_F6_BORNES_NORMALES_PREFIX',
    rawInput: 'Bornes normales : 0.41€ / kWh',
    expectedParsed: {
      shape: 'regex-kwh-v1',
      elements: [elem('ENERGY', 0.41, 'eur_per_kwh', 'energy_eur_per_kwh')],
      prefixContext: 'Bornes normales',
      subscriptionMarker: null,
      notes: [],
      warnings: [],
    },
    manualHandDerivation:
      "Bornes normales prefix → AC/slow connector class. 174 rows in CSV.",
  },

  // ── F7: multi-clause energy + time-min (AED, 4 rows) ──────────────
  {
    syntheticId: 'FRREGEX_FIXTURE_F7_MULTI_ENERGY_TIME',
    rawInput: '0,35€/kWh + 0,05€/mn',
    expectedParsed: {
      shape: 'regex-kwh-v1',
      elements: [
        elem('ENERGY', 0.35, 'eur_per_kwh', 'energy_eur_per_kwh'),
        elem('TIME', 3, 'eur_per_hour', 'time_eur_per_min'),
      ],
      prefixContext: null,
      subscriptionMarker: null,
      notes: [],
      warnings: [],
    },
    manualHandDerivation:
      'Multi-clause: 0.35 €/kWh + 0.05 €/mn (= 3.0 €/hr after × 60). AED-style hybrid energy+time. 4 rows.',
  },

  // ── F8: subscription marker (151-row pattern) ─────────────────────
  {
    syntheticId: 'FRREGEX_FIXTURE_F8_SUBSCRIPTION_MARKER',
    rawInput: '0,40€ / kwh pour les non abonnés.',
    expectedParsed: {
      shape: 'regex-kwh-v1',
      elements: [elem('ENERGY', 0.4, 'eur_per_kwh', 'energy_eur_per_kwh')],
      prefixContext: null,
      subscriptionMarker: 'pour les non abonnés',
      notes: [],
      warnings: [],
    },
    manualHandDerivation:
      'Non-subscriber price (0.40 €/kWh). T13 maps subscriptionMarker to subscription_id alias if known. 151 rows in CSV.',
  },

  // ── F9: 3-clause hybrid with time-window phrase + flat session ────
  // 205-row CSV pattern. Time-window phrase surfaces as note (DC-T12-I).
  {
    syntheticId: 'FRREGEX_FIXTURE_F9_HYBRID_3CLAUSE',
    rawInput:
      '0,35€/kWh + 0,03€/min entre 6h et 18h, 15€ la session entre 18h et 6h',
    expectedParsed: {
      shape: 'regex-kwh-v1',
      elements: [
        elem('ENERGY', 0.35, 'eur_per_kwh', 'energy_eur_per_kwh'),
        elem('TIME', 1.8, 'eur_per_hour', 'time_eur_per_min'),
        elem('FLAT', 15, 'eur_per_session', 'flat_session'),
      ],
      prefixContext: null,
      subscriptionMarker: null,
      notes: [TIME_WINDOW_NOTE],
      warnings: [],
    },
    manualHandDerivation:
      '0.35 €/kWh + 0.03 €/min (= 1.8 €/hr) + 15€ session-flat. Time-window "entre 6h et 18h" + "entre 18h et 6h" detected; surfaced as note (deferred to v2 per DC-T12-I). 205 rows in CSV.',
  },

  // ── F10: decimal-cts ambiguity, no other clauses → REJECTED ───────
  // Listed under SUCCESS fixtures intentionally? No — this is a
  // NON_SUCCESS case (input is valid hallmark but extraction yields 0
  // elements). Moved to NON_SUCCESS_FIXTURES below.

  // ── F11 (was DC-T12 addition): F-edenauto verbatim multi-clause ───
  // 67 rows in CSV, "voitutre" typo (Edenauto Toulouse). The typo is
  // in surrounding prose; price extraction is robust to it.
  {
    syntheticId: 'FRREGEX_FIXTURE_F11_EDENAUTO_VERBATIM',
    rawInput:
      'lorsque la voitutre est branché:on applique 0.32€/Kwh + 0.1€ /min ( App Tarif) lorsque la voiture est chargée mais toujours branché: on applique 0.1€/min (App tarif)',
    expectedParsed: {
      shape: 'regex-kwh-v1',
      elements: [
        elem('ENERGY', 0.32, 'eur_per_kwh', 'energy_eur_per_kwh'),
        elem('TIME', 6, 'eur_per_hour', 'time_eur_per_min'),
        elem('TIME', 6, 'eur_per_hour', 'time_eur_per_min'),
      ],
      prefixContext: null,
      subscriptionMarker: null,
      notes: [],
      warnings: [],
    },
    manualHandDerivation:
      "Edenauto Toulouse (67 rows). 'voitutre' typo in prose; price extraction robust. Extracts: 0.32 €/kWh + 0.1 €/min × 60 = 6 €/hr (charging time) + 0.1 €/min × 60 = 6 €/hr (occupation time, restated). T13 dedupes the two TIME elements at same price.",
  },
];

export const REGEX_KWH_NON_SUCCESS_FIXTURES: readonly RegexKwhNonSuccessFixture[] = [
  // ── 'rejected' — no hallmark ──────────────────────────────────────
  {
    label: 'empty string',
    rawInput: '',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no €/cts hallmark',
  },
  {
    label: 'whitespace only',
    rawInput: '   ',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no €/cts hallmark',
  },
  {
    label: 'T09 sentinel sample (TRUE)',
    rawInput: 'TRUE',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no €/cts hallmark',
  },
  {
    label: 'T10 DRIVECO JSON',
    rawInput:
      '{"fixedPrice":0,"energyPrice":0.49,"minimumBilling":0,"matrix":[],"matrixOSF":[],"hasDynamicTarif":false,"ecoHour":false}',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no €/cts hallmark',
  },
  {
    label: 'T11 CITEOS template (different phrasing — "par kwh", not "/kWh")',
    rawInput: 'par défaut : 0.42€ par kwh de charge',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no €/cts hallmark',
  },
  {
    label: 'T11 P3 URL only',
    rawInput: 'https://belib.paris',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no €/cts hallmark',
  },
  {
    label: 'no-unit value (0.45 kwh — kwh present but no €/cts)',
    rawInput: '0.45 kwh',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no €/cts hallmark',
  },
  {
    label: 'mojibake (€ → â‚¬, no proper € symbol)',
    rawInput: '1â‚¬/kWh',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no €/cts hallmark',
  },

  // ── 'rejected' — hallmark + 0 clauses (decimal cts only) ──────────
  {
    label: 'decimal cts only (EVBOX): hallmark matches but element dropped as ambiguous',
    rawInput: '0,30cts/KWh',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no atomic clauses extracted',
  },
];
