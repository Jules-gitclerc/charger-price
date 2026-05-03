import { describe, it, expect } from 'vitest';

import { parseCiteosTemplate, PARSER_VERSION } from '../citeos-template';
import {
  CITEOS_SUCCESS_FIXTURES,
  CITEOS_NON_SUCCESS_FIXTURES,
} from '../citeos-template.fixtures';

describe('P1 CITEOS template parser', () => {
  it('declares its parser_version', () => {
    expect(PARSER_VERSION).toBe('citeos-template-v1');
  });

  describe('SUCCESS fixtures — deep-equal expectedParsed', () => {
    for (const fx of CITEOS_SUCCESS_FIXTURES) {
      it(`[${fx.syntheticId}]`, () => {
        const result = parseCiteosTemplate(fx.rawInput);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.parsed).toEqual(fx.expectedParsed);
        }
      });
    }
  });

  describe('NON_SUCCESS fixtures — outcome + reason classification', () => {
    for (const fx of CITEOS_NON_SUCCESS_FIXTURES) {
      it(`[${fx.expectedOutcome}] ${fx.label}`, () => {
        const result = parseCiteosTemplate(fx.rawInput);
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
});
