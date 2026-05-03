import { describe, it, expect } from 'vitest';

import { detectSentinel, PARSER_VERSION } from '../sentinel';
import { SENTINEL_FIXTURES, NON_SENTINEL_FIXTURES } from '../sentinel.fixtures';

describe('P5 sentinel detector', () => {
  it('declares its parser_version', () => {
    expect(PARSER_VERSION).toBe('sentinel-v1');
  });

  describe('SENTINEL_FIXTURES — each must hit the named rule', () => {
    for (const fx of SENTINEL_FIXTURES) {
      const label = `[${fx.expectedRule}] ${JSON.stringify(fx.input).slice(0, 60)}`;
      it(label, () => {
        const result = detectSentinel(fx.input);
        expect(result.isSentinel).toBe(true);
        if (result.isSentinel) {
          expect(result.rule).toBe(fx.expectedRule);
        }
      });
    }
  });

  describe('NON_SENTINEL_FIXTURES — must fall through to downstream parsers', () => {
    for (const fx of NON_SENTINEL_FIXTURES) {
      const label = `[${fx.parserTerritory ?? 'edge'}] ${fx.reason}`;
      it(label, () => {
        const result = detectSentinel(fx.input);
        expect(result.isSentinel).toBe(false);
      });
    }
  });
});
