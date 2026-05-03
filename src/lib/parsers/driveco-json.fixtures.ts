// Fixtures for the P0 DRIVECO JSON parser.
//
// SUCCESS fixtures: 5 covering each (energyPrice × matrixOSF pattern)
// combo present in the live data (.cache/irve.csv 2026-05-02). Each
// declares an `expectedParsed` for deep-equal assertion — catches
// numeric drift, OSF-tier-conversion bugs, unit errors.
//
// PDC IDs are SYNTHETIC (FRDRVE_FIXTURE_*). Real PDC IDs would create
// accidental coupling with live state — if DRIVECO retires a station
// between fixture commit and a future read, the fixture would
// reference a non-existent ID. Fixtures are about JSON shape, not
// stations. The smoke runner reads real CSV; that's where real IDs live.
//
// NON_SUCCESS fixtures: cover the error/rejected boundary explicitly,
// per T10 design call DC-T10-F:
//   - 'error'    = JSON.parse threw (infrastructure)
//   - 'rejected' = JSON parsed but provably not DRIVECO-shape

import type { DriveCoParsed } from './driveco-json';

export type DrivecoSuccessFixture = {
  syntheticId: string;
  rawJson: string;
  expectedParsed: DriveCoParsed;
  manualHandDerivation: string;
};

export type DrivecoNonSuccessFixture = {
  label: string;
  rawInput: string;
  expectedOutcome: 'error' | 'rejected';
  expectedReasonContains?: string;
};

const INTERVAL_NOTE =
  "matrixOSF.interval=1 interpreted as 'per minute' (operator-undocumented). " +
  'Idle price 0.20€/min becomes 12€/hr in OCPI PARKING_TIME. If a real DRIVECO ' +
  'session receipt later contradicts this, ship driveco-json-v2 with corrected ' +
  'semantics. Source rows: ~1,553 affected as of parser-version=driveco-json-v1.';

// 0.20€/min × 60 = 12 €/hr (would be 12.000000000000002 without round4 in parser).
// 0.30€/min × 60 = 18 €/hr (exact).
// 0.10€/min × 60 = 6 €/hr (exact).
function patternAExpected(energyPrice: number, perHourEur: number): DriveCoParsed {
  return {
    shape: 'driveco-v1',
    energyPriceEurPerKwh: energyPrice,
    fixedPriceEur: 0,
    minimumBillingEur: 0,
    osfTiers: [
      { fromSeconds: 900, toSeconds: 1800, pricePerHourEur: perHourEur },
      { fromSeconds: 1800, toSeconds: null, pricePerHourEur: 0 },
    ],
    flags: { hasDynamicTarif: false, ecoHour: false },
    notes: [INTERVAL_NOTE],
  };
}

function patternBExpected(energyPrice: number, perHourEur: number): DriveCoParsed {
  return {
    shape: 'driveco-v1',
    energyPriceEurPerKwh: energyPrice,
    fixedPriceEur: 0,
    minimumBillingEur: 0,
    osfTiers: [
      { fromSeconds: 900, toSeconds: null, pricePerHourEur: perHourEur },
    ],
    flags: { hasDynamicTarif: false, ecoHour: false },
    notes: [INTERVAL_NOTE],
  };
}

function rawA(energyPrice: number, osfPriceEurPerMin: number): string {
  return JSON.stringify({
    fixedPrice: 0,
    energyPrice,
    minimumBilling: 0,
    matrix: [],
    matrixOSF: [
      { duration: 0, interval: 1, price: osfPriceEurPerMin, gracePeriodBeforeOSF: 900 },
      { duration: 15, interval: 1, price: 0, gracePeriodBeforeOSF: 0 },
    ],
    hasDynamicTarif: false,
    ecoHour: false,
  });
}

function rawB(energyPrice: number, osfPriceEurPerMin: number): string {
  return JSON.stringify({
    fixedPrice: 0,
    energyPrice,
    minimumBilling: 0,
    matrix: [],
    matrixOSF: [
      { duration: 0, interval: 1, price: osfPriceEurPerMin, gracePeriodBeforeOSF: 900 },
    ],
    hasDynamicTarif: false,
    ecoHour: false,
  });
}

export const DRIVECO_SUCCESS_FIXTURES: readonly DrivecoSuccessFixture[] = [
  {
    syntheticId: 'FRDRVE_FIXTURE_051',
    rawJson: rawB(0.51, 0.2),
    expectedParsed: patternBExpected(0.51, 12),
    manualHandDerivation:
      '0.51€/kWh ENERGY + 12€/hr (=0.20€/min) PARKING_TIME from session-end+900s, open-ended. Pattern B (697 rows in CSV).',
  },
  {
    syntheticId: 'FRDRVE_FIXTURE_039',
    rawJson: rawA(0.39, 0.2),
    expectedParsed: patternAExpected(0.39, 12),
    manualHandDerivation:
      '0.39€/kWh ENERGY + 12€/hr (=0.20€/min) PARKING_TIME from session-end+900s to 1800s, then 0€/hr from 1800s onward. Pattern A (690 rows in CSV).',
  },
  {
    syntheticId: 'FRDRVE_FIXTURE_054',
    rawJson: rawA(0.54, 0.3),
    expectedParsed: patternAExpected(0.54, 18),
    manualHandDerivation:
      '0.54€/kWh ENERGY + 18€/hr (=0.30€/min) PARKING_TIME from session-end+900s to 1800s, then 0€/hr. Pattern A (162 rows in CSV).',
  },
  {
    syntheticId: 'FRDRVE_FIXTURE_049',
    rawJson: rawA(0.49, 0.2),
    expectedParsed: patternAExpected(0.49, 12),
    manualHandDerivation:
      '0.49€/kWh ENERGY + 12€/hr (=0.20€/min) PARKING_TIME tiered. Pattern A (2 rows in CSV — rare).',
  },
  {
    syntheticId: 'FRDRVE_FIXTURE_030',
    rawJson: rawA(0.3, 0.1),
    expectedParsed: patternAExpected(0.3, 6),
    manualHandDerivation:
      '0.30€/kWh ENERGY (lowest observed) + 6€/hr (=0.10€/min) PARKING_TIME tiered. Pattern A (2 rows in CSV — rare).',
  },
];

export const DRIVECO_NON_SUCCESS_FIXTURES: readonly DrivecoNonSuccessFixture[] = [
  // ── 'error' cases (JSON.parse threw) ───────────────────────────────
  {
    label: 'malformed JSON (truncated)',
    rawInput: '{not valid json',
    expectedOutcome: 'error',
    expectedReasonContains: 'JSON.parse failed',
  },
  {
    label: 'P5 sentinel sample — empty string (JSON.parse throws on empty)',
    rawInput: '',
    expectedOutcome: 'error',
    expectedReasonContains: 'JSON.parse failed',
  },
  {
    label: 'P5 sentinel sample — TRUE bool (uppercase, not a JSON literal)',
    rawInput: 'TRUE',
    expectedOutcome: 'error',
    expectedReasonContains: 'JSON.parse failed',
  },
  {
    label: 'P1 CITEOS sample (free text, no JSON)',
    rawInput: 'entre 07:00 et 23:00 : 0.45833€ par kwh de charge',
    expectedOutcome: 'error',
    expectedReasonContains: 'JSON.parse failed',
  },
  {
    label: 'P2 regex sample (€/kWh prose)',
    rawInput: '0,29€ / kWh',
    expectedOutcome: 'error',
    expectedReasonContains: 'JSON.parse failed',
  },

  // ── 'rejected' cases (JSON parsed, shape wrong) ────────────────────
  {
    label: 'empty object',
    rawInput: '{}',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'energyPrice',
  },
  {
    label: 'JSON array',
    rawInput: '[]',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'not an object',
  },
  {
    label: 'plain string JSON',
    rawInput: '"hello"',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'not an object',
  },
  {
    label: 'numeric JSON',
    rawInput: '0.49',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'not an object',
  },
  {
    label: 'lowercase true (parses to boolean, not an object)',
    rawInput: 'true',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'not an object',
  },
  {
    label: 'energyPrice present but matrixOSF missing',
    rawInput: '{"energyPrice":0.49,"fixedPrice":0,"minimumBilling":0}',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'matrixOSF',
  },
  {
    label: 'negative energyPrice',
    rawInput: '{"energyPrice":-1,"fixedPrice":0,"minimumBilling":0,"matrixOSF":[]}',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'energyPrice',
  },
  {
    label: 'partial DRIVECO with corrupted matrixOSF entry (duration is string)',
    rawInput:
      '{"energyPrice":0.51,"fixedPrice":0,"minimumBilling":0,"matrixOSF":[{"duration":"not_a_number","interval":1,"price":0.2,"gracePeriodBeforeOSF":900}]}',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'duration',
  },
  {
    label: 'matrixOSF interval not 1 (potential v2 marker)',
    rawInput:
      '{"energyPrice":0.51,"fixedPrice":0,"minimumBilling":0,"matrixOSF":[{"duration":0,"interval":60,"price":0.2,"gracePeriodBeforeOSF":900}]}',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'interval',
  },
  {
    label: 'non-first matrixOSF entry has non-zero grace (shape variant)',
    rawInput:
      '{"energyPrice":0.51,"fixedPrice":0,"minimumBilling":0,"matrixOSF":[{"duration":0,"interval":1,"price":0.2,"gracePeriodBeforeOSF":900},{"duration":15,"interval":1,"price":0,"gracePeriodBeforeOSF":300}]}',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'only entry 0 may carry grace',
  },
];
