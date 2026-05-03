// P3 URL extractor parser — Prix-Bornes parser pipeline
//
// Pure function. No I/O. Extracts URL-only `tarification` entries
// (operator-portal links). 8,384 of 224,467 PDC rows (3.7%) match
// the URL-only shape as of 2026-05-02. T13 pre-flight surfaced 11
// distinct URLs (highly concentrated: Belib' / Total EV / Métropolis
// dominate).
//
// STRICT URL-ONLY (DC-T13-C — load-bearing)
// -----------------------------------------
// Pre-flight showed ALL 8,384 hallmark-matching rows are clean
// URL-only — zero with prefix text, zero with trailing text, zero
// malformed. The hallmark regex is anchored at start AND end:
//   ^\s*https?://[^\s]+\s*$
// Anything mixed (e.g. 'voir https://...') gets rejected. The 0-mixed
// finding was empirical, not assumed; if a future row ships a URL
// embedded in prose, it rejects with a diagnostic visible in
// parser_outcomes.
//
// NO STATION_TARIFFS WRITE (W5 hard rule)
// ---------------------------------------
// P3 does not extract a price — it extracts a pointer for M2 follow-up
// scraping. T13.2 orchestrator records the URL in:
//   - parser_outcomes.parsed_value_json.url (audit trail)
//   - live.stations.tariff_url (existing column from T06b)
// NO row is written to live.station_tariffs. The viewer interprets
// absence of station_tariffs as "tarif non communiqué".
//
// FAILURE MODES
// -------------
// 'rejected' — input doesn't match the strict URL-only hallmark.
//              Most non-URL inputs fall here cheaply.
// 'error'    — `new URL()` constructor threw despite hallmark match
//              (extremely rare; a hallmark-matching string with
//              malformed authority/path could in principle trip the
//              constructor). Kept for symmetry with T10/T11/T12.
//
// PARSER VERSIONING
// -----------------
// `<parser-slug-without-underscore>-v<integer>`. Bump on any behavior
// change.

export const PARSER_VERSION = 'url-extractor-v1' as const;

// Strict URL-only hallmark. Anchored at both ends after trim.
// `[^\s]+` ensures no embedded whitespace within the URL.
const HALLMARK_REGEX = /^\s*https?:\/\/[^\s]+\s*$/;

export type UrlExtractorParsed = {
  shape: 'url-extractor-v1';
  url: string;
  scheme: 'http' | 'https';
  host: string;
};

export type UrlExtractorResult =
  | { ok: true; parsed: UrlExtractorParsed }
  | { ok: false; outcome: 'error' | 'rejected'; reason: string };

export function parseUrlExtractor(input: string): UrlExtractorResult {
  // 1. Strict URL-only hallmark.
  if (!HALLMARK_REGEX.test(input)) {
    return {
      ok: false,
      outcome: 'rejected',
      reason: 'no URL-only hallmark (input not matching ^\\s*https?://[^\\s]+\\s*$)',
    };
  }

  // 2. Normalize and parse via WHATWG URL constructor.
  const trimmed = input.trim();
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch (err) {
    return {
      ok: false,
      outcome: 'error',
      reason: `URL constructor failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. Validate scheme is exactly http or https (the constructor
  // accepts protocols like 'ftp:' / 'mailto:' for syntactically-valid
  // strings; hallmark already restricts to http(s) but defend in depth).
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return {
      ok: false,
      outcome: 'rejected',
      reason: `unexpected scheme: ${parsedUrl.protocol}`,
    };
  }
  const scheme: 'http' | 'https' =
    parsedUrl.protocol === 'http:' ? 'http' : 'https';

  // 4. Host must be non-empty.
  if (!parsedUrl.host) {
    return { ok: false, outcome: 'rejected', reason: 'empty host' };
  }

  return {
    ok: true,
    parsed: {
      shape: 'url-extractor-v1',
      url: trimmed,
      scheme,
      host: parsedUrl.host,
    },
  };
}
