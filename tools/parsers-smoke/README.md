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

## Adding a new smoke runner

When a new parser module lands (T10 P0 DRIVECO, T11 P1 CITEOS, T12 P2 regex, T13 P3 URL), add a sibling smoke script following the `sentinel.ts` shape:

1. Pure read of `.cache/irve.csv`
2. Apply the parser to each row
3. Print counts + acceptance bars
4. Exit non-zero on regression
