// Fixtures for the P1 CITEOS template parser.
//
// SUCCESS fixtures: cover each clause type + the comma-bug repair
// + the multi-price warning (FRBFCEVDIJZ1, real fixture row from
// Plan §T11 — verified present in .cache/irve.csv 2026-05-02).
// Each declares an `expectedParsed` for deep-equal assertion.
//
// NON_SUCCESS fixtures: cover the rejected boundary (no hallmark vs
// hallmark-but-no-clauses). The 'error' outcome is not naturally
// reachable for this regex parser; no fixture for it.

import type {
  CiteosTemplateParsed,
  CiteosElement,
  CiteosTime,
} from './citeos-template';

export type CiteosSuccessFixture = {
  syntheticId: string;
  rawInput: string;
  expectedParsed: CiteosTemplateParsed;
  manualHandDerivation: string;
};

export type CiteosNonSuccessFixture = {
  label: string;
  rawInput: string;
  expectedOutcome: 'error' | 'rejected';
  expectedReasonContains?: string;
};

// Build helpers — keep fixture declarations terse and reviewable.
const elem = (
  dimension: CiteosElement['dimension'],
  pricePerUnitEur: number,
  unit: CiteosElement['unit'],
  restriction: CiteosTime | null,
  sourceClause: CiteosElement['sourceClause'],
): CiteosElement => ({
  dimension,
  pricePerUnitEur,
  unit,
  restriction,
  sourceClause,
});

const tw = (startLocal: string, endLocal: string): CiteosTime => ({
  startLocal,
  endLocal,
});

const COMMA_BUG_NOTE =
  "upstream stringification artifact detected ('par heure ,\\'occupation'); " +
  "repaired to 'par heure d\\'occupation' before extraction. Source: " +
  'FRS84EVCAXI1-class rows in CPO CITEOS Vaucluse (1 occurrence in 12,020 ' +
  'CITEOS-template rows as of parser-version=citeos-template-v1).';

export const CITEOS_SUCCESS_FIXTURES: readonly CiteosSuccessFixture[] = [
  // ── F1: minimal bare_energy only (5-row CSV pattern) ──────────────
  {
    syntheticId: 'FRCITEOS_FIXTURE_F1_BARE_MIN',
    rawInput: '0.333€ par kwh de charge',
    expectedParsed: {
      shape: 'citeos-template-v1',
      elements: [elem('ENERGY', 0.333, 'eur_per_kwh', null, 'bare_energy')],
      notes: [],
      warnings: [],
    },
    manualHandDerivation:
      'Single bare_energy clause → 1 ENERGY element at 0.333 €/kWh, no restriction. Real pattern (5 rows in CSV: CPO CITEOS / FRCTSEV* family).',
  },

  // ── F2: default + bare hybrid (448-row CSV pattern) ───────────────
  {
    syntheticId: 'FRCITEOS_FIXTURE_F2_DEFAULT_PLUS_BARE',
    rawInput:
      "par défaut : 0.42€ par kwh de charge, 6.0€ par heure d'occupation hors charge",
    expectedParsed: {
      shape: 'citeos-template-v1',
      elements: [
        // Extraction order: time-windows first (0 here), then default,
        // then bare. So default_energy precedes bare_parking_off.
        elem('ENERGY', 0.42, 'eur_per_kwh', null, 'default_energy'),
        elem('PARKING_TIME', 6.0, 'eur_per_hour', null, 'bare_parking_off'),
      ],
      notes: [],
      warnings: [],
    },
    manualHandDerivation:
      'default_energy + bare_parking_off. 2 elements, different dimensions, no multi-price. (448-row CSV pattern.)',
  },

  // ── F3: top-frequency 4-clause template (2,816-row CSV pattern) ───
  {
    syntheticId: 'FRCITEOS_FIXTURE_F3_TOP_FREQ',
    rawInput:
      "entre 08:00 et 20:00 : 0.30916667€ par kwh de charge, 3.75€ par heure d'occupation hors charge, entre 20:00 et 08:00 : 0.30916667€ par kwh de charge, par défaut : 0.30916667€ par kwh de charge",
    expectedParsed: {
      shape: 'citeos-template-v1',
      elements: [
        // time_window_energy comes after _parking_off, _charging_time,
        // _start_fee in the spec order; here only _energy matches.
        elem('ENERGY', 0.3092, 'eur_per_kwh', tw('08:00', '20:00'), 'time_window_energy'),
        elem('ENERGY', 0.3092, 'eur_per_kwh', tw('20:00', '08:00'), 'time_window_energy'),
        elem('ENERGY', 0.3092, 'eur_per_kwh', null, 'default_energy'),
        elem('PARKING_TIME', 3.75, 'eur_per_hour', null, 'bare_parking_off'),
      ],
      notes: [],
      warnings: [],
    },
    manualHandDerivation:
      '0.30916667 → round4 → 0.3092 (numeric(10,4) precision). 4 elements, all single-price per (dimension, restriction) — no warnings. (2,816-row pattern, eborn-dominated.)',
  },

  // ── F4: FRBFCEVDIJZ1 verbatim, multi-price warnings ───────────────
  {
    syntheticId: 'FRCITEOS_FIXTURE_F4_FRBFCEVDIJZ1',
    rawInput:
      "entre 08:00 et 19:00 : 20.0€ par heure d'occupation hors charge, 0.41667€ par kwh de charge, entre 19:00 et 08:00 : 0.41667€ par kwh de charge, par défaut : 0.41667€ par kwh de charge, entre 08:00 et 19:00 : 15.0€ par heure d'occupation hors charge, 0.33334€ par kwh de charge, entre 19:00 et 08:00 : 0.33334€ par kwh de charge, par défaut : 0.33334€ par kwh de charge",
    expectedParsed: {
      shape: 'citeos-template-v1',
      elements: [
        // time_window_parking_off (2 hits, in source order)
        elem('PARKING_TIME', 20, 'eur_per_hour', tw('08:00', '19:00'), 'time_window_parking_off'),
        elem('PARKING_TIME', 15, 'eur_per_hour', tw('08:00', '19:00'), 'time_window_parking_off'),
        // time_window_energy (2 hits)
        elem('ENERGY', 0.4167, 'eur_per_kwh', tw('19:00', '08:00'), 'time_window_energy'),
        elem('ENERGY', 0.3333, 'eur_per_kwh', tw('19:00', '08:00'), 'time_window_energy'),
        // default_energy (2 hits)
        elem('ENERGY', 0.4167, 'eur_per_kwh', null, 'default_energy'),
        elem('ENERGY', 0.3333, 'eur_per_kwh', null, 'default_energy'),
        // bare_energy (2 hits — the un-prefixed restatements)
        elem('ENERGY', 0.4167, 'eur_per_kwh', null, 'bare_energy'),
        elem('ENERGY', 0.3333, 'eur_per_kwh', null, 'bare_energy'),
      ],
      notes: [],
      // Group iteration order = insertion order. First multi-price
      // group inserted: PARKING_TIME tw 08-19. Then ENERGY tw 19-08.
      // Then ENERGY no-restriction.
      warnings: [
        'multiple distinct prices for dimension=PARKING_TIME at time-window 08:00-19:00 grain: [20, 15]. Parser emits both elements; downstream consumer must disambiguate (likely connector-specific rates).',
        'multiple distinct prices for dimension=ENERGY at time-window 19:00-08:00 grain: [0.4167, 0.3333]. Parser emits both elements; downstream consumer must disambiguate (likely connector-specific rates).',
        'multiple distinct prices for dimension=ENERGY at no-restriction grain: [0.4167, 0.3333]. Parser emits both elements; downstream consumer must disambiguate (likely connector-specific rates).',
      ],
    },
    manualHandDerivation:
      'FRBFCEVDIJZ1 (CPO CITEOS Region-Bfc, real fixture row per Plan §5). 8 elements covering 4 distinct (dim, restr) groups; 3 of those groups have 2 distinct prices (likely connector-specific rates: AC vs DC connectors at the same station). 3 multi-price warnings.',
  },

  // ── F5: prix de départ (default_start_fee, CPO CITEOS CCHPB) ──────
  {
    syntheticId: 'FRCITEOS_FIXTURE_F5_CCHPB_START_FEE',
    rawInput:
      "par défaut :  prix de départ 0.25€, 3.0€ par heure d'occupation hors charge, 0.433333€ par kwh de charge, par défaut :  prix de départ 0.25€, 0.43333€ par kwh de charge, 2.5€ par heure de charge, 3.0€ par heure d'occupation hors charge, par défaut :  prix de départ 0.25€, 0.43333€ par kwh de charge, 3.0€ par heure d'occupation hors charge",
    expectedParsed: {
      shape: 'citeos-template-v1',
      elements: [
        // default_start_fee (3 hits — note double-space in 'par défaut :  prix de départ' tolerated by \s+)
        elem('FLAT', 0.25, 'eur_per_session', null, 'default_start_fee'),
        elem('FLAT', 0.25, 'eur_per_session', null, 'default_start_fee'),
        elem('FLAT', 0.25, 'eur_per_session', null, 'default_start_fee'),
        // bare_parking_off (3 hits)
        elem('PARKING_TIME', 3.0, 'eur_per_hour', null, 'bare_parking_off'),
        elem('PARKING_TIME', 3.0, 'eur_per_hour', null, 'bare_parking_off'),
        elem('PARKING_TIME', 3.0, 'eur_per_hour', null, 'bare_parking_off'),
        // bare_charging_time (1 hit)
        elem('TIME', 2.5, 'eur_per_hour', null, 'bare_charging_time'),
        // bare_energy (3 hits — 0.433333 and 0.43333 both round4 to 0.4333)
        elem('ENERGY', 0.4333, 'eur_per_kwh', null, 'bare_energy'),
        elem('ENERGY', 0.4333, 'eur_per_kwh', null, 'bare_energy'),
        elem('ENERGY', 0.4333, 'eur_per_kwh', null, 'bare_energy'),
      ],
      notes: [],
      warnings: [],
    },
    manualHandDerivation:
      "CPO CITEOS CCHPB (FRHPBEVKSRI3-class, 7 rows in CSV). FLAT initial fee + parking + charging-time + energy. round4 collapses 0.433333 and 0.43333 to 0.4333 (no multi-price warning despite different input precision).",
  },

  // ── F6: comma-bug repair (FRS84EVCAXI1, single occurrence) ────────
  {
    syntheticId: 'FRCITEOS_FIXTURE_F6_COMMA_BUG',
    rawInput:
      "par défaut : 0.33334€ par kwh de charge, par défaut : 0.33334€ par kwh de charge, 2.5€ par heure ,'occupation hors charge, 2.5€ par heure de charge, par défaut : 0.33334€ par kwh de charge",
    expectedParsed: {
      shape: 'citeos-template-v1',
      elements: [
        // default_energy (3 hits)
        elem('ENERGY', 0.3333, 'eur_per_kwh', null, 'default_energy'),
        elem('ENERGY', 0.3333, 'eur_per_kwh', null, 'default_energy'),
        elem('ENERGY', 0.3333, 'eur_per_kwh', null, 'default_energy'),
        // bare_parking_off (1 hit, the repaired one)
        elem('PARKING_TIME', 2.5, 'eur_per_hour', null, 'bare_parking_off'),
        // bare_charging_time (1 hit)
        elem('TIME', 2.5, 'eur_per_hour', null, 'bare_charging_time'),
      ],
      notes: [],
      warnings: [COMMA_BUG_NOTE],
    },
    manualHandDerivation:
      "FRS84EVCAXI1 (CPO CITEOS Vaucluse, the only comma-bug row in 12,020 CITEOS rows). Pre-process repairs 'par heure ,\\'occupation' → 'par heure d\\'occupation', emits warning, then extracts normally. ok=true (don't reject input bugs; surface in audit trail per discipline observation #4).",
  },
];

export const CITEOS_NON_SUCCESS_FIXTURES: readonly CiteosNonSuccessFixture[] = [
  // ── 'rejected' — no hallmark ──────────────────────────────────────
  {
    label: 'empty string',
    rawInput: '',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no CITEOS hallmark',
  },
  {
    label: 'whitespace only',
    rawInput: '   ',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no CITEOS hallmark',
  },
  {
    label: 'T09 sentinel sample (TRUE)',
    rawInput: 'TRUE',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no CITEOS hallmark',
  },
  {
    label: 'T10 DRIVECO JSON',
    rawInput:
      '{"fixedPrice":0,"energyPrice":0.49,"minimumBilling":0,"matrix":[],"matrixOSF":[],"hasDynamicTarif":false,"ecoHour":false}',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no CITEOS hallmark',
  },
  {
    label: 'P2 regex sample (€/kWh — slash-separated, not "par kwh")',
    rawInput: '0,29€ / kWh',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no CITEOS hallmark',
  },
  {
    label: 'P3 URL only',
    rawInput: 'https://belib.paris',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no CITEOS hallmark',
  },
  {
    label: 'PowerDot R6 disclaimer (no CITEOS hallmark, even though long)',
    rawInput:
      'Les tarifs de recharge peuvent varier en fonction de plusieurs facteurs, y compris le fournisseur de services, l\'emplacement de la borne, la puissance de charge, et les éventuelles promotions en cours...',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no CITEOS hallmark',
  },

  // ── 'rejected' — hallmark matches but no atomic clause extracts ───
  {
    label: 'synthetic: hallmark with non-numeric price',
    rawInput: 'par défaut : abc€ par kwh de charge',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no atomic clauses extracted',
  },
];
