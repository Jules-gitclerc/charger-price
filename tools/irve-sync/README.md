# `tools/irve-sync` — IRVE consolidated-CSV ingestion runner (T06a → T06b)

The Python entrypoint that downloads the IRVE consolidated CSV from
data.gouv.fr, lands it in `staging.irve_raw`, then calls
`live.run_irve_swap()` to upsert into `live.stations` /
`live.charge_points`. The SQL function closes the run row internally on
the success / partial path; on swap failure the runner issues a separate
`live.close_ingestion_run(..., 'failed', …)` per the E15 post-rollback
contract.

## Modes

### `--validate-fixture-only`

Offline pre-processor smoke against
`tools/irve-sync/test/fixture-10rows.csv`. **No network. No DB.**

```bash
python3 tools/irve-sync/main.py --validate-fixture-only
```

Used by `.github/workflows/irve-sync-fixture.yml` (step 3) on every PR
that touches `tools/irve-sync/`. Exits non-zero on a logic regression in
the header validator or per-row pre-processor.

### Full run (default)

Downloads the CSV, SHA-aborts if the upstream blob is unchanged, opens a
`live.ingestion_runs` row in `status='running'`, TRUNCATEs
`staging.irve_raw`, pipes a transformed stream through `psql \copy`,
calls `live.run_irve_swap()` to upsert into live (the SQL closes the
run row internally to `'success'` or `'partial'`), and advances the SHA
cache in `staging.ingestion_run_meta`.

```bash
export SUPABASE_DB_URL='postgresql://…'   # direct, NOT pooler
export GIT_SHA="$(git rev-parse HEAD)"
python3 tools/irve-sync/main.py
```

The SHA-abort path inserts a fully-closed `status='success'` row in one
shot. On swap failure, the runner issues a separate
`close_ingestion_run(..., 'failed', error_message)` after the swap txn
rolls back, then exits 1. The SHA cache is only advanced after a
successful swap+close — a failed run leaves the cache untouched so the
next workflow run retries naturally.

### `--force-refresh`

Operator-only escape hatch. Clears
`staging.ingestion_run_meta` for the IRVE slug **before** the SHA
check, so the runner always proceeds to swap even when the upstream
blob is unchanged.

```bash
python3 tools/irve-sync/main.py --force-refresh
```

Used to re-test the pipeline against staging that's already
up-to-date — for example, after a SQL function change that needs a
real-data smoke against the existing 211k-row staging without waiting
for upstream to publish a new CSV.

**Combination with `DRY_RUN=true` is a no-op for the cache clear.** The
dry-run early-exit branch fires before the force-refresh DELETE — by
design, since (force-refresh + dry-run) is a contradictory request
(operator says "wipe cache so I re-process" and also "don't actually
process anything"). Operators wanting "clear then telemetry" should run
two invocations:

```bash
# Step 1: clear cache + actually process (advances cache to new SHA)
python3 tools/irve-sync/main.py --force-refresh

# Step 2: telemetry-only invocation against the just-advanced cache
DRY_RUN=true python3 tools/irve-sync/main.py
```

## Mode matrix

| `--force-refresh` | `DRY_RUN` env | Behavior |
|:---:|:---:|---|
| `F` | `F` | **Vanilla.** orphan sweep → download → SHA-check vs cache; if match → short-lived `success` row + return; if mismatch → open `running` row → TRUNCATE+COPY → swap → SQL closes row → meta upsert + log. Swap failure → separate `close('failed')` + exit 1. |
| `T` | `F` | **Force-refresh.** orphan sweep → download → DELETE meta cache → SHA-check (always passes, cache empty) → open row → TRUNCATE+COPY → swap → SQL closes row → meta upsert (re-populates cache). |
| `F` | `T` | **Dry-run.** orphan sweep → download → short-lived `success` row with telemetry message → return. No staging write, no SHA check, no swap, no meta touch. |
| `T` | `T` | **Contradictory.** dry-run early-exits before the force-refresh DELETE — cache is **NOT** cleared. See two-step workaround above. |

## Local setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r tools/irve-sync/requirements.txt
```

Python 3.11+ required (CI pins via `actions/setup-python@v5`).

Postgres client (`psql`) required for full-run mode — the runner
shellouts to `psql` for every DB call (the COPY path uses `\copy`,
which is psql-side, not libpq-side, so a Python-only `psycopg2`
substitute won't cover it).

```bash
# macOS
brew install libpq && brew link --force libpq

# Debian / Ubuntu
sudo apt-get install -y postgresql-client
```

Verify with `psql --version` (≥ 14 recommended; CI runners ship 16).

## Env vars

| Var | Mode | Notes |
|---|---|---|
| `SUPABASE_DB_URL` | full run | Direct Postgres URI (transaction pooler **rejected** because COPY needs a real session). Never logged. |
| `GIT_SHA` | full run | Stamped on every `live.ingestion_runs.git_sha`. Required — the runner fails loud if absent. The workflow wires `${{ github.sha }}` here. |
| `IRVE_RESOURCE_ID` | full run | Optional override for the data.gouv.fr resource UUID. Defaults to the pin in `main.py` (`DEFAULT_RESOURCE_ID`). |
| `DRY_RUN` | full run | `true`/`1`/`yes` → telemetry-only invocation; download but skip TRUNCATE/COPY/swap/meta. Writes a short-lived `success` row and exits 0. See mode matrix above. |

## Fixture file (`test/fixture-10rows.csv`)

53 columns: 40 IRVE v2.3.0 spec + 12 data.gouv consolidation extras + 1
synthetic future-spec column (`future_certif_v24`) to exercise the drift
bucket. 10 data rows covering:

- **(a)** all 7 required columns populated — rows 1, 2, 4–8, 10.
- **(b)** optional column missing — row 3 (Tesla; `observations` empty
  among others).
- **(c)** unknown v2.4-style column at the file level — `future_certif_v24`
  is in the header for every row; rows 1, 2, 6 carry a non-empty value
  that the pre-processor packs into the `_extra_columns` JSONB.
- **(d)** row-level malformed — row 9 (`id_station_itinerance` empty).
  The runner skips it and logs the reason. Note that row 4's quoted
  embedded newline in `nom_station` is **not** malformed; CSV handles
  quoted newlines correctly. Upstream-broken CSV (unquoted newlines,
  decode errors) is a separate path exercised in full-run mode by the
  per-row try/except wrapper.

## Adding a new fixture row

Edit `tools/irve-sync/test/fixture-10rows.csv` directly. Keep the row
count at 10 unless you also update the docstring above. If you add a new
edge case, document it in the list above and add a comment in `main.py`
near the relevant code path.

## What this tool does NOT do

- Tariff parsing — that's T09–T13.
- Reverse geocoding — that's T07.
- Operator alias resolution — that's T08 (the swap deliberately leaves
  `live.stations.operator_id` / `network_id` untouched).
- Write to `live.station_tariffs`, `live.parser_outcomes`, or any tariff
  table — see T06 brief hard rules #7 and #8.
