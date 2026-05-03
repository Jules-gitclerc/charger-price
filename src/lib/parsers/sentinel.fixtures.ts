// Fixtures for the P5 sentinel detector.
//
// SENTINEL_FIXTURES: each entry MUST hit the named rule. The unit test
// asserts both isSentinel===true AND result.rule===expectedRule —
// catches rule-drift bugs (e.g. R5 substring accidentally matching
// what should hit R6 prefix).
//
// NON_SENTINEL_FIXTURES: each entry must NOT classify as sentinel.
// These exercise the false-positive risk of every rule.
//
// Sources: Phase 1 §D.1-§D.3 + Plan §5 fixture rosters (P0/P1/P2/P3).
// Real IRVE values where possible; synthetic values labeled.

import type { SentinelRule } from './sentinel';

export type SentinelFixture = {
  input: string;
  expectedRule: SentinelRule;
  sourceNote?: string;
};

export type NonSentinelFixture = {
  input: string;
  reason: string;
  parserTerritory?: 'P0' | 'P1' | 'P2' | 'P3';
};

export const SENTINEL_FIXTURES: readonly SentinelFixture[] = [
  // R1 — empty / whitespace-only
  { input: '', expectedRule: 'R1_empty', sourceNote: 'Plan §5 sentinel/empty.json' },
  { input: '   ', expectedRule: 'R1_empty' },
  { input: '\t\n', expectedRule: 'R1_empty' },

  // R2 — dash
  { input: '-', expectedRule: 'R2_dash', sourceNote: 'Plan §5 sentinel/dash.json' },
  { input: ' - ', expectedRule: 'R2_dash', sourceNote: 'whitespace tolerated by trim' },

  // R3 — bool string
  { input: 'TRUE', expectedRule: 'R3_bool_string', sourceNote: 'Plan §5 sentinel/bool-true.json' },
  { input: 'false', expectedRule: 'R3_bool_string' },
  { input: 'False', expectedRule: 'R3_bool_string' },

  // R4 — short whitelist
  { input: 'Inconnu', expectedRule: 'R4_short_no_digits', sourceNote: 'Plan §5 sentinel/inconnu.json' },
  { input: 'N/A', expectedRule: 'R4_short_no_digits' },
  { input: '/', expectedRule: 'R4_short_no_digits', sourceNote: 'Phase 1 §D.2 (CEGELEC)' },
  { input: 'FIXE', expectedRule: 'R4_short_no_digits', sourceNote: 'Phase 1 §D.2 (Bornes CIVP)' },
  { input: 'Au kWh', expectedRule: 'R4_short_no_digits', sourceNote: 'Phase 1 §D.2 (Réseau MOBIVE)' },

  // R5 — substring negation phrases
  {
    input: 'Tarification non concernée',
    expectedRule: 'R5_negation_phrases',
    sourceNote: 'synthetic but pattern-realistic',
  },
  {
    input: 'Borne à venir',
    expectedRule: 'R5_negation_phrases',
    sourceNote: 'synthetic but pattern-realistic',
  },
  {
    input: 'Prix non communiqué par l\'opérateur',
    expectedRule: 'R5_negation_phrases',
  },

  // R6 — Power Dot disclaimer prefix
  {
    input:
      'Les tarifs de recharge peuvent varier en fonction de plusieurs facteurs, y compris le fournisseur de services, l\'emplacement de la borne, la puissance de charge, et les éventuelles promotions en cours...',
    expectedRule: 'R6_powerdot_prefix',
    sourceNote: 'Phase 1 §D.3 — 12,890-row Power Dot disclaimer',
  },
  {
    input:
      'Les tarifs de recharge peuvent varier en fonction de plusieurs facteurs.\n',
    expectedRule: 'R6_powerdot_prefix',
    sourceNote: 'trailing newline variant',
  },
];

export const NON_SENTINEL_FIXTURES: readonly NonSentinelFixture[] = [
  // P0 territory — DRIVECO JSON (Plan §5 driveco/*)
  {
    input: '{"fixedPrice":0,"energyPrice":0.49,"minimumBilling":0,"matrixOSF":[{"duration":0,"interval":1,"price":0.2,"gracePeriodBeforeOSF":900},{"duration":15,"interval":1,"price":0,"gracePeriodBeforeOSF":0}],"hasDynamicTarif":false,"ecoHour":false}',
    reason: 'P0 DRIVECO JSON',
    parserTerritory: 'P0',
  },
  {
    input: '{"energyPrice":0.39}',
    reason: 'P0 minimal JSON',
    parserTerritory: 'P0',
  },
  {
    input: '{"energyPrice":0.30,"matrixOSF":[]}',
    reason: 'P0 lowest observed price',
    parserTerritory: 'P0',
  },

  // P1 territory — CITEOS templates (Plan §5 citeos/*)
  {
    input: 'entre 07:00 et 23:00 : 0.45833€ par kwh de charge, 4.5€ par heure d\'occupation hors charge',
    reason: 'P1 CITEOS template, time-windowed',
    parserTerritory: 'P1',
  },
  {
    input: 'par défaut : 0.4667€ par kwh de charge',
    reason: 'P1 CITEOS par-défaut-only',
    parserTerritory: 'P1',
  },
  {
    input: 'par défaut : 0.33334€ par kwh de charge, 2.5€ par heure ,\'occupation hors charge',
    reason: 'P1 CITEOS with the buggy-comma upstream stringification',
    parserTerritory: 'P1',
  },

  // P2 territory — €/kWh regex (Plan §5 regex/*)
  { input: '0,29€ / kWh', reason: 'P2 Electra-style', parserTerritory: 'P2' },
  { input: '0.33€/kWh', reason: 'P2 Mobilygreen', parserTerritory: 'P2' },
  { input: '0,30cts/KWh', reason: 'P2 EVBOX cts/€ ambiguity', parserTerritory: 'P2' },
  { input: 'HPC 49cts/Kwh', reason: 'P2 TotalEnergies HPC', parserTerritory: 'P2' },
  {
    input: 'lorsque la voitutre est branché:on applique 0.32€/Kwh + 0.1€ /min',
    reason: 'P2 multi-clause edenauto',
    parserTerritory: 'P2',
  },

  // P3 territory — URL only (Plan §5 url/*)
  { input: 'https://belib.paris', reason: 'P3 URL only', parserTerritory: 'P3' },
  { input: 'https://www.metropolis-recharge.fr/', reason: 'P3 URL only', parserTerritory: 'P3' },
  { input: 'https://apps.total-ev-charge.com/charge-points', reason: 'P3 URL only', parserTerritory: 'P3' },

  // Edge — short prose, no whitelist match
  {
    input: 'voir l\'opérateur',
    reason: 'short prose but neither stated-absence nor whitelisted — must fall through, NOT sentinel',
  },
  {
    input: '0',
    reason: 'single digit (length 1) — not in R4 whitelist; downstream parsers may decide what to do',
  },

  // Edge — bool prefix but content present (R3 must be exact match, not startsWith)
  {
    input: 'TRUE 0,30€/kWh',
    reason: 'starts with TRUE but carries a price — must not match R3',
    parserTerritory: 'P2',
  },

  // Edge — disclaimer-prefix-like but different operator's substantive text
  {
    input: 'Les tarifs sont affichés sur la borne et sur l\'app Foo. 0,45€/kWh.',
    reason: 'starts with "Les tarifs" but NOT the Power Dot prefix verbatim',
    parserTerritory: 'P2',
  },
];
