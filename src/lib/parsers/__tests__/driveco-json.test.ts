import { describe, it, expect } from 'vitest';

import { parseDriveCoJson, PARSER_VERSION } from '../driveco-json';
import {
  DRIVECO_SUCCESS_FIXTURES,
  DRIVECO_NON_SUCCESS_FIXTURES,
} from '../driveco-json.fixtures';

describe('P0 DRIVECO JSON parser', () => {
  it('declares its parser_version', () => {
    expect(PARSER_VERSION).toBe('driveco-json-v1');
  });

  describe('SUCCESS fixtures — deep-equal expectedParsed', () => {
    for (const fx of DRIVECO_SUCCESS_FIXTURES) {
      it(`[${fx.syntheticId}]`, () => {
        const result = parseDriveCoJson(fx.rawJson);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.parsed).toEqual(fx.expectedParsed);
        }
      });
    }
  });

  describe('NON_SUCCESS fixtures — outcome + reason classification', () => {
    for (const fx of DRIVECO_NON_SUCCESS_FIXTURES) {
      it(`[${fx.expectedOutcome}] ${fx.label}`, () => {
        const result = parseDriveCoJson(fx.rawInput);
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
