// Fixtures for the P3 URL extractor parser.
//
// SUCCESS fixtures: cover all 11 distinct URLs observed in the live
// CSV (T13 pre-flight 2026-05-02), plus http vs https variants and
// trailing-slash variants. Each declares expectedParsed for deep-equal
// assertion.
//
// NON_SUCCESS fixtures: cover the rejected boundary — every prior-
// stage shape (P5 sentinel / P0 DRIVECO / P1 CITEOS / P2 regex-kwh)
// must NOT match P3, plus mixed-text-and-URL, malformed-scheme, and
// missing-scheme.

import type { UrlExtractorParsed } from './url-extractor';

export type UrlExtractorSuccessFixture = {
  syntheticId: string;
  rawInput: string;
  expectedParsed: UrlExtractorParsed;
  manualHandDerivation: string;
};

export type UrlExtractorNonSuccessFixture = {
  label: string;
  rawInput: string;
  expectedOutcome: 'error' | 'rejected';
  expectedReasonContains?: string;
};

const made = (
  url: string,
  scheme: 'http' | 'https',
  host: string,
): UrlExtractorParsed => ({
  shape: 'url-extractor-v1',
  url,
  scheme,
  host,
});

export const URL_EXTRACTOR_SUCCESS_FIXTURES: readonly UrlExtractorSuccessFixture[] = [
  {
    syntheticId: 'FRURL_FIXTURE_F1_BELIB',
    rawInput: 'https://belib.paris',
    expectedParsed: made('https://belib.paris', 'https', 'belib.paris'),
    manualHandDerivation:
      "Belib' (Paris municipal). Top URL by row count (2,078 rows in CSV).",
  },
  {
    syntheticId: 'FRURL_FIXTURE_F2_TOTAL_EV',
    rawInput: 'https://apps.total-ev-charge.com/charge-points',
    expectedParsed: made(
      'https://apps.total-ev-charge.com/charge-points',
      'https',
      'apps.total-ev-charge.com',
    ),
    manualHandDerivation:
      'TotalEnergies Charge Rapide. URL with path. 2,023 rows in CSV.',
  },
  {
    syntheticId: 'FRURL_FIXTURE_F3_METROPOLIS',
    rawInput: 'https://www.metropolis-recharge.fr/',
    expectedParsed: made(
      'https://www.metropolis-recharge.fr/',
      'https',
      'www.metropolis-recharge.fr',
    ),
    manualHandDerivation:
      'Métropolis. URL with trailing slash (host-only path). 1,913 rows in CSV.',
  },
  {
    syntheticId: 'FRURL_FIXTURE_F4_OUESTCHARGE',
    rawInput: 'https://www.ouestcharge-paysdelaloire-moncompte.fr/fr/tarifs',
    expectedParsed: made(
      'https://www.ouestcharge-paysdelaloire-moncompte.fr/fr/tarifs',
      'https',
      'www.ouestcharge-paysdelaloire-moncompte.fr',
    ),
    manualHandDerivation:
      'e-Vadea / Pays de la Loire. URL with multi-segment path. 863 rows in CSV.',
  },
  {
    syntheticId: 'FRURL_FIXTURE_F5_SIEG63_HTTP',
    rawInput: 'http://www.sieg63.orios-infos.com/tarifs',
    expectedParsed: made(
      'http://www.sieg63.orios-infos.com/tarifs',
      'http',
      'www.sieg63.orios-infos.com',
    ),
    manualHandDerivation:
      'SIEG63 (Auvergne). HTTP variant (not HTTPS). 285 rows in CSV. Important: scheme detection must distinguish http vs https.',
  },
  {
    syntheticId: 'FRURL_FIXTURE_F6_SEOLIS_TRAILING_SLASH',
    rawInput: 'https://www.seolis.net/alterbase/nos-tarifs/',
    expectedParsed: made(
      'https://www.seolis.net/alterbase/nos-tarifs/',
      'https',
      'www.seolis.net',
    ),
    manualHandDerivation:
      'AlterBase Seolis. URL with path AND trailing slash. 221 rows in CSV.',
  },
  {
    syntheticId: 'FRURL_FIXTURE_F7_FUZED',
    rawInput: 'https://www.go-fuzed.com/cgv',
    expectedParsed: made(
      'https://www.go-fuzed.com/cgv',
      'https',
      'www.go-fuzed.com',
    ),
    manualHandDerivation:
      'Fuzed. URL with path (cgv = conditions générales de vente). 85 rows in CSV.',
  },
];

export const URL_EXTRACTOR_NON_SUCCESS_FIXTURES: readonly UrlExtractorNonSuccessFixture[] = [
  {
    label: 'empty string',
    rawInput: '',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no URL-only hallmark',
  },
  {
    label: 'whitespace only',
    rawInput: '   ',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no URL-only hallmark',
  },
  {
    label: 'T09 sentinel sample (TRUE)',
    rawInput: 'TRUE',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no URL-only hallmark',
  },
  {
    label: 'T10 DRIVECO JSON',
    rawInput:
      '{"fixedPrice":0,"energyPrice":0.49,"minimumBilling":0,"matrix":[],"matrixOSF":[],"hasDynamicTarif":false,"ecoHour":false}',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no URL-only hallmark',
  },
  {
    label: 'T11 CITEOS template',
    rawInput: 'par défaut : 0.42€ par kwh de charge',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no URL-only hallmark',
  },
  {
    label: 'T12 P2 regex sample (€/kWh)',
    rawInput: '0,29€ / kWh',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no URL-only hallmark',
  },
  {
    label: 'mixed text+URL (URL not bare-only)',
    rawInput: 'voir https://belib.paris pour les tarifs',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no URL-only hallmark',
  },
  {
    label: 'malformed scheme typo',
    rawInput: 'htps://belib.paris',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no URL-only hallmark',
  },
  {
    label: 'missing scheme',
    rawInput: 'belib.paris',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no URL-only hallmark',
  },
  {
    label: 'ftp scheme (hallmark would not match anyway)',
    rawInput: 'ftp://example.com/file',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no URL-only hallmark',
  },
  {
    label: 'URL with embedded space (rejects via hallmark [^\\s]+)',
    rawInput: 'https://example.com/path with space',
    expectedOutcome: 'rejected',
    expectedReasonContains: 'no URL-only hallmark',
  },
];
