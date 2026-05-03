# `tools/irve-sync` — IRVE consolidated-CSV ingestion runner (T06a)

The Python entrypoint that downloads the IRVE consolidated CSV from
data.gouv.fr and lands it in `staging.irve_raw`. T06b's swap function
(migration 0012, not yet shipped) will diff staging against `live` in a
later step.

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
`staging.irve_raw`, and pipes a transformed stream through `psql \copy`.

```bash
export SUPABASE_DB_URL='postgresql://…'   # direct, NOT pooler
export GIT_SHA="$(git rev-parse HEAD)"
python3 tools/irve-sync/main.py
```

T06a leaves the run row in `status='running'` on the COPY-load path —
T06b will close it. The SHA-abort path inserts a fully-closed
`status='success'` row in one shot.

## Local setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r tools/irve-sync/requirements.txt
```

Python 3.11+ required (CI pins via `actions/setup-python@v5`).

## Env vars

| Var | Mode | Notes |
|---|---|---|
| `SUPABASE_DB_URL` | full run | Direct Postgres URI (transaction pooler **rejected** because COPY needs a real session). Never logged. |
| `GIT_SHA` | full run | Stamped on every `live.ingestion_runs.git_sha`. Required — the runner fails loud if absent. The workflow wires `${{ github.sha }}` here. |
| `IRVE_RESOURCE_ID` | full run | Optional override for the data.gouv.fr resource UUID. Defaults to the pin in `main.py` (`DEFAULT_RESOURCE_ID`). |

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
- Diff `staging` against `live` — that's T06b's `live.run_irve_swap()`.
- Write to `live.station_tariffs`, `live.parser_outcomes`, or any tariff
  table — see T06 brief hard rules #7 and #8.
