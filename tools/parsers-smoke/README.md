# tools/parsers-smoke

Diagnostic-only smoke runners for the Prix-Bornes parser pipeline. **Not for production.**

These scripts read a local IRVE CSV cache and apply individual parser modules from `src/lib/parsers/`, printing distribution counts and exit-coded regression guards. They do **not** connect to the database, do **not** write to `live.parser_outcomes`, and do **not** ingest anything.

The production runner is `tools/run-parsers/` (M1 W5 T13 — the parser pipeline orchestrator). That runner:
- reads from the live corpus (resolution per T09 design §0 architectural gap)
- calls the parser chain (P5 → P0 → P1 → P2 → P3)
- writes `live.parser_outcomes` and `live.station_tariffs` per the W5 hard rules
- opens/closes a single `live.ingestion_runs` row per invocation

Smoke runners exist to (a) validate parser behavior against a local snapshot before T13's orchestrator wires them up, and (b) detect regression after parser version bumps.

## Available smoke runners

### `sentinel.ts` — P5 sentinel detector (T09)

Counts how many rows in the CSV trigger each P5 sentinel rule (R1-R6) and how many false positives slip through into P0/P1/P2/P3 territory.

```
pnpm exec tsx tools/parsers-smoke/sentinel.ts
pnpm exec tsx tools/parsers-smoke/sentinel.ts --csv path/to/alt.csv
```

Default CSV: `.cache/irve.csv` (Phase-1 era snapshot, ~151 MB, 224,467 rows).

Exit codes:
- `0` — all guards pass (FP counts are 0 AND total ≥ 95% of the pre-flight floor)
- `1` — regression detected (FP > 0 OR total below floor)
- `2` — environmental fault (CSV missing, header missing, etc.)

The pre-flight floor (`EXPECTED_TOTAL_FLOOR = 175,472`) is anchored to the T09 pre-flight count of 184,708 sentinel hits in `.cache/irve.csv` as of 2026-05-02. The 5% tolerance absorbs minor day-over-day IRVE variance without false alarms; widening the gap signals either a meaningful upstream shift or a parser regression — both worth investigating before commit.

### `driveco-json.ts` — P0 DRIVECO JSON parser (T10)

Attempts `parseDriveCoJson` on every CSV row whose `tarification` matches the DRIVECO detection criterion (`starts-with-'{' AND contains 'energyPrice'`). Reports success/error/rejected breakdown, an `energyPrice × matrixOSF pattern` cross-tab, and a false-positive guard against P5 sentinel territory.

```
pnpm exec tsx tools/parsers-smoke/driveco-json.ts
pnpm exec tsx tools/parsers-smoke/driveco-json.ts --csv path/to/alt.csv
```

Acceptance bar (stricter than T09 because T10 has zero ambiguity in input space):
- success rate ≥ 99% of attempted (current baseline: 1,553 / 1,553 = 100%)
- error count = 0 AND rejected count = 0 (exact baseline)
- sentinel-territory overlap = 0 (P5 should short-circuit before P0; the guard catches confused inputs)

Exit codes match `sentinel.ts`. The cross-tab makes pattern-correlation drift visible — if a future DRIVECO row ships an `energyPrice` value with the wrong matrixOSF pattern, the table reveals it directly.

### `citeos-template.ts` — P1 CITEOS template parser (T11)

Applies `parseCiteosTemplate` to every CSV row, reporting per-clause-type histogram (across all extracted elements), per-enseigne distribution (11 enseignes share the template — multi-operator scope), top-10 clause-set signature distribution (drift signal), comma-bug repair count, multi-price warning count, and FP guards against P5 sentinel + P0 DRIVECO territory.

```
pnpm exec tsx tools/parsers-smoke/citeos-template.ts
pnpm exec tsx tools/parsers-smoke/citeos-template.ts --csv path/to/alt.csv
```

Acceptance bar:
- success rate ≥ 99% of attempted (current baseline: 12,020 / 12,020 = 100%)
- hallmark+0-clauses = 0 (exact baseline — would signal a new clause variant unseen in pre-flight)
- sentinel + DRIVECO territory overlap = 0 (P5 + P0 short-circuit before P1)

Note on per-clause counts: the smoke reports counts AFTER strip-and-extract sequencing (time_window_X and default_X strip their matches before bare_X runs). So `bare_energy` smoke count = (independent regex count) - (time_window_energy) - (default_energy). This is the runtime reality of what the parser emits per clause, not what naive regex counting would suggest. Reconciles to: bare_energy 6,592 = 39,787 - 17,425 - 15,770 ✓.

### `regex-kwh.ts` — P2 regex €/kWh parser (T12)

Applies `parseRegexKwh` to every CSV row. Reports success/rejected breakdown, per-clause histogram (energy_eur_per_kwh / energy_cts_integer / time_eur_per_min / time_eur_per_hour / flat_session), per-enseigne distribution (top 15), centimes interpretation note count, decimal-cts ambiguity input count (probe-based), subscription markers, prefix contexts, multi-clause inputs, time-window informational notes, and 4 FP guards against P5 sentinel + P0 DRIVECO + P1 CITEOS + P3 URL territory.

```
pnpm exec tsx tools/parsers-smoke/regex-kwh.ts
pnpm exec tsx tools/parsers-smoke/regex-kwh.ts --csv path/to/alt.csv
```

Acceptance bar:
- success rate ≥ 99% of attempted (current baseline: 11,660 / 11,685 = 99.79%)
- decimal-cts input rows = 21 ±5 (sole-clause-decimal-cts rows that reject; EVBOX + ZEENCO + tail)
- hallmark+0-clauses ≤ 100 (current: 25 = 21 decimal-cts + 4 inline-connector edge cases like `0.25AC €/kWh`)
- All 4 FP guards = 0 (P5/P0/P1/P3)

Note on the decimal-cts metric: counted via probe regex on raw input, NOT via warning iteration on parser results. Sole-clause decimal-cts rows reject (no successful result to iterate warnings from); the probe catches them all regardless of outcome.

cts disposition (per T12 design DC-T12-A): integer cts ≥ 1 = centimes by industry convention (× 0.01 to €/kWh, with per-element note); decimal cts < 1 = ambiguous (drop element + warning, since 0.30 cts could mean 0.003 €/kWh or be a typo for 0.30 €/kWh — 100× spread, do not silently coerce).

### `url-extractor.ts` — P3 URL extractor parser (T13.1)

Applies `parseUrlExtractor` to every CSV row. Reports success/rejected/errored breakdown, per-distinct-URL distribution (11 URLs in current data, highly concentrated), per-enseigne distribution (top 10), and 4 FP guards against P5 sentinel + P0 DRIVECO + P1 CITEOS + P2 regex-kwh territory.

```
pnpm exec tsx tools/parsers-smoke/url-extractor.ts
pnpm exec tsx tools/parsers-smoke/url-extractor.ts --csv path/to/alt.csv
```

Acceptance bar (strictest of the parser smokes — pre-flight showed 0 ambiguity in input space):
- successfully parsed = exact baseline 8,384 (NOT a tolerance band — drift = signal worth investigating)
- errored count = 0 (URL constructor must not throw on any hallmark-matching input)
- All 4 FP guards = 0 (P5/P0/P1/P2)

P3 ships ZERO station_tariffs writes: it extracts a pointer (URL) for M2 follow-up scraping, not a price. T13.2 orchestrator records the URL in `parser_outcomes.parsed_value_json.url` AND in `live.stations.tariff_url` (existing column from T06b). The viewer interprets absence of a station_tariffs row as "tarif non communiqué".

## Adding a new smoke runner

The 5 W5 parser smokes (T09 P5 + T10 P0 + T11 P1 + T12 P2 + T13.1 P3) are now complete. T13.2 orchestrator wires them into a pipeline. Future parsers (M1.5+ Electra, etc.) follow the established shape:

1. Pure read of `.cache/irve.csv`
2. Apply the parser to each row
3. Print counts + acceptance bars
4. Exit non-zero on regression
