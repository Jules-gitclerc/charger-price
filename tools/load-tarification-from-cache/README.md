# `tools/load-tarification-from-cache` — T13.0.5 (M1 WORKAROUND)

Loads `live.stations.tarification` directly from `.cache/irve.csv`, bypassing the `staging.irve_raw` swap pipeline that hits `FileFallocate` disk-full failures on Supabase free-tier and Pro-tier projects with insufficient disk allocation (E21 instances #2 + #3).

## Why this exists

`tools/irve-sync/main.py` (T06+T13.0) is the canonical path: download CSV → COPY into staging → `live.run_irve_swap()` → `live.copy_tarification_from_staging()` → TRUNCATE staging. The swap step creates a `~50-100 MB` transient `valid_pdcs` TEMP TABLE which, combined with the `~150 MB` staging COPY and WAL bloat, can push the project past its disk allocation regardless of Pro-tier status (the database row-storage limit is independent from the underlying disk volume size on managed Supabase).

This loader provides a parallel temporary path that:
- Reads the local CSV cache directly (no staging COPY, no temp tables)
- Applies the same canonical-row strategy as `live.copy_tarification_from_staging()` (`DISTINCT ON id_station_itinerance ORDER BY date_maj DESC NULLS LAST`)
- UPDATEs `live.stations.tarification` in chunks of 5,000 stations (peak transient ~5-10 MB instead of ~318 MB)

## When to remove

Remove this entire directory when ANY of:

1. Supabase Pro tier disk allocation verified at 8 GB AND `tools/irve-sync` succeeds without `FileFallocate`
2. Chunked-swap refactor of `run_irve_swap()` lands
3. Migration to a non-free-tier hosted Postgres

When removed, restore the canonical flow: `tools/irve-sync/main.py` already calls `live.copy_tarification_from_staging()` between swap and truncate; nothing else needs changing.

## Usage

```bash
export SUPABASE_DB_URL='postgresql://…'
export GIT_SHA="$(git rev-parse HEAD)"  # optional, audit trail

# dry-run: read + dedupe + forecast, no DB writes
python3 tools/load-tarification-from-cache/main.py --dry-run

# real run
python3 tools/load-tarification-from-cache/main.py
```

Pre-step: `.cache/irve.csv` must exist. If absent, run `tools/irve-sync/main.py` once (it will likely fail at the swap stage on free tier, but the CSV download phase succeeds and leaves the cache populated).

## Forecasted output

```
# tarification loader starting (csv=.cache/irve.csv, runner_version=tarification-loader-v1, dry_run=False)
# disk audit (pre-run): 134.3 MB
# reading + deduping CSV...
# rows_seen=224467 (total CSV rows)
# filtered=N₁ (empty/null tarif + ID format-gate)
# dedup_collapsed=N₂ (PDC-grain rows merging to same station)
# canonical_stations=N₃ (post-dedupe station-grain — pre-DB-existence)
# opened ingestion_runs.id=… status=running
# chunk 1: attempted=5000 affected=… cumulative=…
# …
# disk audit (post-chunk-5): 138.2 MB
# …
# disk audit (post-run): 142.7 MB
# rows_updated=N₄ (UPDATEs that touched a live.stations row)
# rows_skipped=N₅
# canonical_minus_updated=N₆ (canonical CSV stations not present in live.stations)
# ingestion_runs.id=… closed status=success
```

Forensic counters mapping:
- `rows_seen` = every row read from CSV (~224,467)
- `filtered` = empty tarif + sentinel id_station_itinerance values
- `dedup_collapsed` = PDC-grain rows that share a station with another row (canonical-row dedupe)
- `canonical_stations` = post-dedupe count (≤ rows_seen − filtered − dedup_collapsed)
- `rows_updated` = stations actually UPDATEd in `live.stations` (canonical_stations ∩ live.stations)
- `canonical_minus_updated` = stations in CSV not present in `live.stations` (BE/AT operators per E18, or station-grain drift)
- `rows_skipped` = filtered + dedup_collapsed (logged into ingestion_runs.rows_skipped)

## Hard rules

| | |
|---|---|
| 1 | NO modification of `tools/irve-sync/main.py` — `copy_tarification_from_staging()` call stays in place dormant |
| 2 | NO new migration — runtime `INSERT ON CONFLICT` for the `tarification_loader_local` source row |
| 3 | Single `ingestion_runs` row per invocation, E15 atomicity contract (status=running → success/failed) |
| 4 | Disk-audit gate pre-run + every 5 chunks at 340 MB threshold |
| 5 | NO changes to `live.stations.tarification` column (already in place via 0018) |
| 6 | NO T06 swap function changes |
| 7 | All string fields escape via `_quote_sql_literal` (T07 BAN runner pattern) |
| 8 | No autocache download — fail-fast if `.cache/irve.csv` missing |
| 9 | No imports from `tools/irve-sync` — self-contained for clean removal |
