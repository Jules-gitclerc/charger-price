// Shared numeric helpers for parser modules.
//
// Extracted at T11.0 (refactor) when the second consumer (P1 CITEOS
// template parser) needed the same float-drift mitigation as P0
// DRIVECO. T10 had `round4` as a private helper; this module is its
// new home.
//
// CONVENTION: keep this module dependency-free and side-effect-free.
// Helpers operate on primitives only. If a future helper needs domain
// types, define it in the parser module that owns the type, not here.

/**
 * Round to 4 decimal places. Matches the `numeric(10,4)` precision of
 * `live.price_components.price` and `live.tariffs.min_price_eur` in
 * migration 0004.
 *
 * Eliminates JS floating-point drift before values land in the parser
 * output. Example: `0.20 * 60` evaluates to `12.000000000000002`;
 * `round4(0.20 * 60)` returns `12` exactly.
 */
export function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
