import { describe, it, expect } from 'vitest';

import { parseUrlExtractor, PARSER_VERSION } from '../url-extractor';
import {
  URL_EXTRACTOR_SUCCESS_FIXTURES,
  URL_EXTRACTOR_NON_SUCCESS_FIXTURES,
} from '../url-extractor.fixtures';

describe('P3 URL extractor parser', () => {
  it('declares its parser_version', () => {
    expect(PARSER_VERSION).toBe('url-extractor-v1');
  });

  describe('SUCCESS fixtures — deep-equal expectedParsed', () => {
    for (const fx of URL_EXTRACTOR_SUCCESS_FIXTURES) {
      it(`[${fx.syntheticId}]`, () => {
        const result = parseUrlExtractor(fx.rawInput);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.parsed).toEqual(fx.expectedParsed);
        }
      });
    }
  });

  describe('NON_SUCCESS fixtures — outcome + reason classification', () => {
    for (const fx of URL_EXTRACTOR_NON_SUCCESS_FIXTURES) {
      it(`[${fx.expectedOutcome}] ${fx.label}`, () => {
        const result = parseUrlExtractor(fx.rawInput);
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
