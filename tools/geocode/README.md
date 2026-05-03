# `tools/geocode` — BAN reverse-geocode runner (T07)

The Python entrypoint that fills `live.stations.consolidated_code_postal`
for the ~22,207 stations missing postal codes (per T07 pre-flight; 42 %
of `live.stations` at W4 start), by batch-calling the BAN
`/reverse/csv/` endpoint and writing through `live.geocode_cache`.

T07.2 ships **fixture mode + the BAN client + the per-row decision
helpers**. The live runner with chunked commits lands in T07.3.

## Modes

### `--validate-fixture-only`

Offline pre-processor smoke against
`tools/geocode/test/fixture-4rows.csv`. **No network. No DB.**

```bash
python3 tools/geocode/main.py --validate-fixture-only
```

The fixture is a CSV that mirrors a BAN `/reverse/csv/` response — input
columns (`longitude`, `latitude`) plus `result_*` columns. The fixture
mode parses it as if it had come from the network, runs the per-row
decision logic, and prints aligned per-row decisions plus an aggregate
summary. Exits non-zero on a logic regression.

### Full run (default)

**Not implemented in T07.2.** `full_run()` raises `NotImplementedError`;
T07.3 will implement the live runner.

## Spec discovery note (T07.2)

A one-off live probe of `https://api-adresse.data.gouv.fr/reverse/csv/`
during T07.2 design discovery surfaced a contradiction with Phase 2 §2.5
and our pre-flight design: **the BAN reverse endpoint does NOT return a
`result_score` field.** The forward `/search/csv/` endpoint returns
`result_score ∈ [0, 1]`; the reverse endpoint returns `result_distance`
in meters instead.

The `confidence_score` value written into `live.geocode_cache` for BAN
reverse rows is therefore a **synthesized** value computed from
`result_distance` via `_score_from_reverse_result`. The bands:

| `result_distance` | Synthesized `confidence_score` | `expires_at` |
|---|---|---|
| ≤ 100 m | 0.95 (housenumber-precision; postal certain) | NULL (never expires) |
| ≤ 1000 m | 0.70 (nearby-feature snap) | now() + 90 d |
| ≤ 10000 m | 0.30 (long snap; postal may differ) | now() + 30 d |
| > 10000 m | 0.10 (functionally a no-match dressed as ok) | now() + 30 d |
| `result_status != 'ok'` | None — no cache row written | — |

`confidence_score = 0.95` for a BAN reverse row means "≤ 100 m snap
distance", **not** "BAN said 0.95". Future maintainers reading rows
back: see `_score_from_reverse_result`'s docstring + the module
docstring in `main.py`.

## Cache key format

The natural key on `live.geocode_cache` is `(address_query, provider)`.
For reverse-geocode lookups this runner sets:

- `address_query = f"reverse:{lon:.6f},{lat:.6f}"`
- `provider = 'ban'`

The 6-decimal precision matches `geocode_cache.{latitude,longitude}`'s
`numeric(9,6)` storage. Examples:

```
reverse:2.349000,48.864000     — Paris (centre)
reverse:3.130000,50.674000     — Wasquehal
reverse:-61.580000,16.243000   — Pointe-à-Pitre (DOM-TOM)
```

The `reverse:` prefix disambiguates from a hypothetical future forward-
geocode cache key (which would be a free-form address string).

## Apply gate

Per T07 design: a cache row is written, but the corresponding
`live.stations.consolidated_code_postal` is updated, only when:

- `result_status = 'ok'`, AND
- synthesized `confidence_score ≥ 0.5`.

Three decision outcomes per BAN response row:

| Decision | Cache row | `live.stations` UPDATE | When |
|---|---|---|---|
| `apply=yes` | written | yes | `ok` AND score ≥ 0.5 |
| `apply=no`  | written | no  | `ok` AND score < 0.5 (forensic only) |
| `apply=skip` | NOT written | no | non-`ok` status (e.g. `not-found`); also covers anomalous `ok`-with-no-distance |

Negative cache (`apply=skip`) intentionally does NOT write a row —
re-querying on subsequent runs is cheap and avoids masking future BAN
coverage improvements.

## Fixture file (`test/fixture-4rows.csv`)

Single CSV containing both BAN input columns AND BAN response columns.
Fixture mode reads it, treats it as a captured response, runs the parser
+ decision logic. The four rows exercise the decision matrix:

| Row | Input lon, lat | Case | Expected behavior |
|---|---|---|---|
| 1 | `2.349, 48.864` (Paris centre) | (a) high-confidence urban | `result_status='ok'`, `result_distance=3 m`, score 0.95, ttl NULL, **apply=yes** |
| 2 | `1.234, 47.123` (rural Berry) | (b) medium-confidence rural | `result_status='ok'`, `result_distance=347 m`, score 0.70, ttl 90 d, **apply=yes** |
| 3 | `-5.6, 48.5` (offshore Brittany) | (c) low-confidence remote | `result_status='ok'`, `result_distance=12000 m`, score 0.10, ttl 30 d, **apply=no** |
| 4 | `4.349, 50.851` (Brussels) | (d) out-of-France no-match | `result_status='not-found'`, all `result_*` empty, **apply=skip** |

Row 1 is real probe data; row 4 is real probe data; rows 2 and 3 are
fabricated to exercise the medium and low bands without re-probing.

## Adding a new fixture row

Edit `tools/geocode/test/fixture-4rows.csv` directly. If you add a new
edge case, document it in the table above.

## Local setup

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r tools/geocode/requirements.txt
```

Python 3.11+ required. The only runtime dependency is `requests`, and
it is imported **lazily inside `_ban_reverse_csv`** so fixture-only
invocations don't require it on `PATH` (mirrors `tools/irve-sync` per
T06a pattern).

For full-run mode (T07.3 only): Postgres client (`psql`) required for
the chunked-commit DB writes — see the install snippet in
`tools/irve-sync/README.md`.

## Env vars

| Var | Mode | Notes |
|---|---|---|
| `SUPABASE_DB_URL` | full run (T07.3) | Session pooler URI — same secret as T06. Never logged. |
| `GIT_SHA` | full run (T07.3) | Stamped on `live.ingestion_runs.git_sha` for the run. Required — fail loud if absent. |
| `BAN_API_BASE_URL` | full run (T07.3) | Optional override. Defaults to `https://api-adresse.data.gouv.fr`. Useful for testing or if BAN moves the host. |

No new GitHub Actions secret needed — T07's runner reuses T06's
`SUPABASE_DB_URL` secret.

## What this tool does NOT do (T07.2 scope)

- Live BAN API call — T07.3.
- `live.stations` SELECT or UPDATE — T07.3.
- `live.geocode_cache` INSERT — T07.3.
- Chunked-commit loop — T07.3.
- GitHub Actions workflow integration — T07.4 if shipped.
- Forward geocoding (address → coords) — out of scope; T07 is reverse only.
- Operator alias resolution — T08.

## Pre-commit gates

The pre-commit hook (`.husky/pre-commit`) lints staged migrations only.
Python sources are not linted. CI may add a `ruff` / `mypy` pass in a
later milestone if value justifies.
