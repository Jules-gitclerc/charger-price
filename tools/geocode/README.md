# `tools/geocode` — BAN reverse-geocode runner (T07)

The Python entrypoint that fills `live.stations.consolidated_code_postal`
for the ~22,207 stations missing postal codes (per T07 pre-flight; 42 %
of `live.stations` at W4 start), by batch-calling the BAN
`/reverse/csv/` endpoint and writing through `live.geocode_cache`.

T07.3 ships the full pipeline. T07.2 (preceded) delivered fixture mode +
the BAN client + the per-row decision helpers; T07.3 added the live
runner, chunked-commit loop, disk-audit gate, and `live.ingestion_runs`
audit-trail integration.

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

End-to-end against live Supabase. Pipeline:

1. Idempotent INSERT of the `ban_reverse_geocode` source row in
   `live.sources` (no migration; the runner ensures its own row).
2. Orphan sweep — UPDATE any `status='running'` BAN row older than
   2 h to `'failed'` (parity with T06; rarely fires for one-shot T07).
3. Pre-flight disk audit (`pg_database_size`).
4. Resume verification — count the work-set; if zero, write a
   short-lived `success` ingestion_runs row with a descriptive
   message (audit-trail consistency: distinguishes "ran with
   nothing to do" from "ran and processed N rows") and exit 0.
5. Open `live.ingestion_runs` row, status=running.
6. **Chunk loop** — until work-set is empty:
   - SELECT next ≤1,000 stations (NULL postal AND not in cache).
   - POST `(lon, lat)` batch to BAN `/reverse/csv/`.
   - Parse response, run `_decision_for_row` per row.
   - Build single-statement CTE: INSERT-ON-CONFLICT into
     `geocode_cache` + UPDATE-FROM into `live.stations` guarded by
     `confidence_score >= 0.5`. One psql round-trip per chunk —
     atomic transaction.
   - Sleep 200 ms (BAN politeness).
   - Every 5 chunks, `_disk_gate_check_and_pause` against
     `DISK_GATE_THRESHOLD_BYTES` (340 MB).
7. Close ingestion_runs row to `'success'` (rows_skipped=0) or
   `'partial'` (rows_skipped>0) via `live.close_ingestion_run`.
8. Post-flight disk audit, multi-line summary log.

```bash
export SUPABASE_DB_URL='postgresql://…'   # session pooler URL (E10)
export GIT_SHA="$(git rev-parse HEAD)"
python3 tools/geocode/main.py
```

**Atomicity contract** (hard rule #4 at chunk grain): each chunk's
INSERT+UPDATE is a single transaction. Mid-chunk failure rolls back
that chunk's writes; chunks 1..N-1 are preserved. Re-run resumes
automatically because the work-set query excludes already-cached
coords. No retry logic in the runner — failure → `SystemExit(1)`
with a clear chunk-N reference.

**Disk-discipline contract** (hard rule #2): if `pg_database_size`
exceeds `DISK_GATE_THRESHOLD_BYTES` after a chunk, the runner pauses
10 s for autovacuum then re-checks. If still over, `SystemExit(1)`
with a recovery-instruction message. Committed chunks remain.

**Negative-cache discipline** (T07.3 late-discovery refinement,
overrides T07.1 design call (d)): BAN `not-found` responses produce
cache rows with NULL postal/commune/INSEE/normalized_address and
`confidence_score = 0.0`, with a 30 d TTL. The work-set's NOT EXISTS
filter then excludes these (lon, lat) values on subsequent chunks
of the same run AND on subsequent runs until the 30 d TTL expires.
Without this, work-set NOT EXISTS doesn't filter not-found rows
and the chunk loop becomes infinite. The 30 d sweep window
preserves the "re-query when BAN coverage improves" property.

The UPDATE gate (`score >= 0.5`) means score=0 negative-cache rows
never trigger station UPDATEs.

**Coord-sharing reality** (T07.3 erratum candidate E22): the
work-set has a ~1.39 station-per-coord dedupe factor — multiple
operator-side `id_station_itinerance` values share physical
GPS at highway rest stops, urban parking decks, industrial-zone
charging hubs. The chunk SQL builder dedupes by `address_query`
within the chunk (Postgres ON CONFLICT cannot affect the same
conflict-target row twice in one statement — same family as
SQLSTATE 21000 / E17). The UPDATE-FROM still matches all stations
sharing those coords because the join key is (lon, lat), so 1
cache row may update N stations.

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

Note that row 4 displays `ttl=30d` post-T07.3 because of the negative-
cache refinement — `apply='skip'` rows now produce a cache row with
NULL fields and 30 d TTL rather than no row at all.

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

For full-run mode: Postgres client (`psql`) required for the chunked-
commit DB writes — see the install snippet in
`tools/irve-sync/README.md`.

## Env vars

| Var | Mode | Notes |
|---|---|---|
| `SUPABASE_DB_URL` | full run | Session pooler URI — same secret as T06. Never logged. |
| `GIT_SHA` | full run | Stamped on `live.ingestion_runs.git_sha` for the run. Required — fail loud if absent. |
| `BAN_API_BASE_URL` | full run | Optional override. Defaults to `https://api-adresse.data.gouv.fr`. Useful for testing or if BAN moves the host. |

No new GitHub Actions secret needed — T07's runner reuses T06's
`SUPABASE_DB_URL` secret.

## Acceptance metrics in practice

T07's first full run (T07.3) yielded:

- Cache rows total: 15,975
- Cache rows `score >= 0.5` (apply gate): 15,651 — **98.0% of unique coords successfully resolved**
- Cache rows `score = 0` (negative cache, 30 d TTL): 324 — BAN unable to resolve
- `live.stations` with `consolidated_code_postal` filled: 51,046 / 52,806 = **96.7% station-level coverage**
- Stations still NULL after T07.3: 1,760 — structurally unresolvable by BAN reverse (highway rest stops, motorway parking, industrial zones, foreign-operator coords)

The `score >= 0.5` cache count is the cleaner engineering metric — it
measures the runner's effectiveness against the workable input. The
station-level rate is what users see; it's lower than the cache rate
because of coord-sharing across stations (see E22 candidate, ~1.39
stations per unique coord on average).

## What this tool does NOT do

- Forward geocoding (address → coords) — out of scope; T07 is reverse only.
- GitHub Actions workflow integration — T07 is one-shot, not cron-scheduled. Re-run manually if needed; the work-set query is idempotent and the negative-cache 30 d TTL handles BAN coverage drift.
- Operator alias resolution — T08.

## Pre-commit gates

The pre-commit hook (`.husky/pre-commit`) lints staged migrations only.
Python sources are not linted. CI may add a `ruff` / `mypy` pass in a
later milestone if value justifies.
