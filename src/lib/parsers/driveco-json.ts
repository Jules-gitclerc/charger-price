// P0 DRIVECO JSON parser — Prix-Bornes parser pipeline
//
// Pure function. No I/O. Parses the structured JSON that DRIVECO emits
// inside the IRVE `tarification` free-text field. 1,553 of 224,467
// PDC rows (0.7%) carry this shape as of 2026-05-02. All 1,553 are
// enseigne 'DRIVECO'.
//
// SHAPE CONTRACT (driveco-json-v1)
// ---------------------------------
// All current data has the same 7 top-level keys. Required for parse
// success: { energyPrice, fixedPrice, minimumBilling, matrixOSF }.
// Optional with sensible defaults: { hasDynamicTarif=false,
// ecoHour=false }. The `matrix` key is always [] in current data and
// is read-but-ignored by this parser; a future non-empty `matrix`
// would be visible in parser_outcomes raw_input but not currently
// extracted (would warrant driveco-json-v2).
//
// MATRIXOSF SEMANTICS (load-bearing assumption)
// ----------------------------------------------
// matrixOSF.interval=1 interpreted as 'per minute' (operator-
// undocumented). Idle price 0.20€/min becomes 12€/hr in OCPI
// PARKING_TIME. If a real DRIVECO session receipt later contradicts
// this, ship driveco-json-v2 with corrected semantics. Source rows:
// ~1,553 affected as of parser-version=driveco-json-v1.
//
// Each matrixOSF entry: {duration, interval, price, gracePeriodBeforeOSF}.
//   - gracePeriodBeforeOSF (seconds) on entry[0] = OSF activation delay
//     after session-end. Non-first entries MUST have grace=0; this
//     parser rejects any data that violates it (signals a shape variant).
//   - duration (minutes, cumulative from OSF activation) = when this
//     tier kicks in.
//   - interval=1 = per-minute billing increment (the load-bearing
//     assumption above).
//   - price = €/min during this tier.
//
// OUTPUT NORMALIZATION
// --------------------
// We convert to OCPI semantics: PARKING_TIME price is €/hour,
// fromSeconds/toSeconds are absolute seconds from session-end.
// Float-drift mitigation: round €/hr to 4 decimals (matches the
// destination column live.price_components.price numeric(10,4) in
// migration 0004).
//
// VAT
// ---
// DRIVECO JSON shape v1 carries no VAT field; T13 should set
// tariffs.tax_included = NULL (OCPI 'unknown' tri-state) by design.
//
// CURRENCY
// --------
// DRIVECO publishes in EUR exclusively. This parser hardcodes
// EUR-equivalent units in the output. Future non-EUR operators
// (M2 territory) will need explicit currency handling.
//
// FAILURE MODES
// -------------
// 'error'    — parsing infrastructure failed (JSON.parse threw). Input
//              MIGHT be valid DRIVECO that we couldn't process due to a
//              runtime issue. Candidate for retry on parser bug fix.
// 'rejected' — JSON parsed structurally but provably not DRIVECO-shape
//              (missing required key, wrong type, unsupported variant).
//              Input is DEFINITELY not for this parser. Not a retry
//              candidate; if a 6th shape ships, write driveco-json-v2.
//
// PARSER VERSIONING
// -----------------
// Convention: <parser-slug-without-underscore>-v<integer>. Bump on any
// behavior change. No semver; the only question is "did behavior
// change?". Shared across all P-stage parsers.

export const PARSER_VERSION = 'driveco-json-v1' as const;

const INTERVAL_NOTE =
  "matrixOSF.interval=1 interpreted as 'per minute' (operator-undocumented). " +
  'Idle price 0.20€/min becomes 12€/hr in OCPI PARKING_TIME. If a real DRIVECO ' +
  'session receipt later contradicts this, ship driveco-json-v2 with corrected ' +
  'semantics. Source rows: ~1,553 affected as of parser-version=driveco-json-v1.';

export type DriveCoOsfTier = {
  fromSeconds: number;
  toSeconds: number | null;
  pricePerHourEur: number;
};

export type DriveCoParsed = {
  shape: 'driveco-v1';
  energyPriceEurPerKwh: number;
  fixedPriceEur: number;
  minimumBillingEur: number;
  osfTiers: DriveCoOsfTier[];
  flags: {
    hasDynamicTarif: boolean;
    ecoHour: boolean;
  };
  notes: string[];
};

export type DriveCoJsonResult =
  | { ok: true; parsed: DriveCoParsed }
  | { ok: false; outcome: 'error' | 'rejected'; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNonNegNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

// Round to 4 decimals (matches numeric(10,4) precision in 0004).
// Eliminates 0.20 * 60 = 12.000000000000002 style float drift before
// the value lands in the parser output.
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

type ValidatedOsfEntry = {
  duration: number;
  interval: 1;
  price: number;
  gracePeriodBeforeOSF: number;
};

export function parseDriveCoJson(input: string): DriveCoJsonResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    return {
      ok: false,
      outcome: 'error',
      reason: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, outcome: 'rejected', reason: 'parsed JSON is not an object' };
  }

  // Required keys present?
  for (const key of ['energyPrice', 'fixedPrice', 'minimumBilling', 'matrixOSF'] as const) {
    if (!(key in parsed)) {
      return { ok: false, outcome: 'rejected', reason: `missing required key: ${key}` };
    }
  }

  // Required-key types valid?
  if (!isFiniteNonNegNumber(parsed.energyPrice)) {
    return { ok: false, outcome: 'rejected', reason: 'energyPrice not a non-negative finite number' };
  }
  if (!isFiniteNonNegNumber(parsed.fixedPrice)) {
    return { ok: false, outcome: 'rejected', reason: 'fixedPrice not a non-negative finite number' };
  }
  if (!isFiniteNonNegNumber(parsed.minimumBilling)) {
    return { ok: false, outcome: 'rejected', reason: 'minimumBilling not a non-negative finite number' };
  }
  if (!Array.isArray(parsed.matrixOSF)) {
    return { ok: false, outcome: 'rejected', reason: 'matrixOSF not an array' };
  }

  // Validate matrixOSF entries.
  const osfRaw = parsed.matrixOSF;
  const validated: ValidatedOsfEntry[] = [];
  for (let i = 0; i < osfRaw.length; i += 1) {
    const e = osfRaw[i];
    if (!isPlainObject(e)) {
      return { ok: false, outcome: 'rejected', reason: `matrixOSF[${i}] not an object` };
    }
    if (!isNonNegInt(e.duration)) {
      return { ok: false, outcome: 'rejected', reason: `matrixOSF[${i}].duration not a non-negative integer` };
    }
    if (e.interval !== 1) {
      return {
        ok: false,
        outcome: 'rejected',
        reason: `matrixOSF[${i}].interval=${JSON.stringify(e.interval)} unsupported (expected 1; ship driveco-json-v2 if a real DRIVECO variant)`,
      };
    }
    if (!isFiniteNonNegNumber(e.price)) {
      return { ok: false, outcome: 'rejected', reason: `matrixOSF[${i}].price not a non-negative finite number` };
    }
    if (!isNonNegInt(e.gracePeriodBeforeOSF)) {
      return {
        ok: false,
        outcome: 'rejected',
        reason: `matrixOSF[${i}].gracePeriodBeforeOSF not a non-negative integer`,
      };
    }
    if (i > 0 && e.gracePeriodBeforeOSF !== 0) {
      return {
        ok: false,
        outcome: 'rejected',
        reason: `matrixOSF[${i}].gracePeriodBeforeOSF=${e.gracePeriodBeforeOSF} unsupported (only entry 0 may carry grace; ship driveco-json-v2 if this is a real DRIVECO variant)`,
      };
    }
    validated.push({
      duration: e.duration,
      interval: 1,
      price: e.price,
      gracePeriodBeforeOSF: e.gracePeriodBeforeOSF,
    });
  }

  // Build OSF tiers in OCPI shape.
  const osfStartSec = validated.length > 0 ? validated[0].gracePeriodBeforeOSF : 0;
  const osfTiers: DriveCoOsfTier[] = validated.map((entry, i) => {
    const next = validated[i + 1];
    return {
      fromSeconds: osfStartSec + entry.duration * 60,
      toSeconds: next ? osfStartSec + next.duration * 60 : null,
      pricePerHourEur: round4(entry.price * 60),
    };
  });

  // Optional flags with safe defaults.
  const hasDynamicTarif = parsed.hasDynamicTarif === true;
  const ecoHour = parsed.ecoHour === true;

  // Notes: always emit the interval-assumption note when matrixOSF has
  // entries. The note is about the shape's contract, not specific data.
  // An empty matrixOSF (hypothetical) would have no interval to interpret.
  const notes: string[] = [];
  if (validated.length > 0) {
    notes.push(INTERVAL_NOTE);
  }

  return {
    ok: true,
    parsed: {
      shape: 'driveco-v1',
      energyPriceEurPerKwh: parsed.energyPrice,
      fixedPriceEur: parsed.fixedPrice,
      minimumBillingEur: parsed.minimumBilling,
      osfTiers,
      flags: { hasDynamicTarif, ecoHour },
      notes,
    },
  };
}
