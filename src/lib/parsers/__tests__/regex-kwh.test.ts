import { describe, it, expect } from 'vitest';

import { parseRegexKwh, PARSER_VERSION } from '../regex-kwh';
import {
  REGEX_KWH_SUCCESS_FIXTURES,
  REGEX_KWH_NON_SUCCESS_FIXTURES,
} from '../regex-kwh.fixtures';

describe('P2 regex €/kWh parser', () => {
  it('declares its parser_version', () => {
    expect(PARSER_VERSION).toBe('regex-kwh-v1');
  });

  describe('SUCCESS fixtures — deep-equal expectedParsed', () => {
    for (const fx of REGEX_KWH_SUCCESS_FIXTURES) {
      it(`[${fx.syntheticId}]`, () => {
        const result = parseRegexKwh(fx.rawInput);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.parsed).toEqual(fx.expectedParsed);
        }
      });
    }
  });

  describe('NON_SUCCESS fixtures — outcome + reason classification', () => {
    for (const fx of REGEX_KWH_NON_SUCCESS_FIXTURES) {
      it(`[${fx.expectedOutcome}] ${fx.label}`, () => {
        const result = parseRegexKwh(fx.rawInput);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.outcome).toBe(fx.expectedOutcome);
          if (fx.expectedReasonContains) {
            expect(result.reason).toContain(fx.expectedReasonContains);
          }
        }
      });
    }
  });

  describe('decimal-cts ambiguity warning surfaces both interpretations', () => {
    it("ZEENCO '0,30cts/KWh' (sole-clause): warning includes both 0.003 and 0.3 interpretations", () => {
      // Hits hallmark, decimal-cts dropped as ambiguous, no other
      // clauses → 'rejected' at end. Warning would have been emitted
      // had any other clause survived. This test verifies the warning
      // text is correct when paired with another clause.
      const hybrid = '0.49€/kWh + 0,30cts/KWh';
      const result = parseRegexKwh(hybrid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.parsed.elements).toHaveLength(1);
        expect(result.parsed.elements[0].pricePerUnitEur).toBe(0.49);
        expect(result.parsed.warnings).toHaveLength(1);
        expect(result.parsed.warnings[0]).toContain('decimal cts value <1 detected (0.3)');
        expect(result.parsed.warnings[0]).toContain('=0.003 €/kWh');
        expect(result.parsed.warnings[0]).toContain('=0.3 €/kWh');
        expect(result.parsed.warnings[0]).toContain('EVBOX, ZEENCO');
      }
    });
  });
});
