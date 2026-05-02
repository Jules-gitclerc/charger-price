# Phase 3 — Implementation plan (M1 only)

> Concrete W1–W5 plan for the **M1 (Data foundations + internal viewer)** milestone defined in `docs/02-architecture.md` §5.
> Date: 2026-05-02.
> M1.5 (public UI), M2, M3 are out of scope for this document.

**M1 success in one sentence.** By end of W5, Jules can type "Wasquehal" into a basic-auth-protected Vercel preview URL and see the 10 nearest stations with their best-known tariff and confidence tier, served from a Postgres that is auto-refreshed daily from IRVE with parsed tariffs from the DRIVECO/CITEOS subsets and one operator scraper feeding `verified` rows.

---

## §1 — Day 1 setup checklist

Numbered, copy-pasteable, dependency-ordered. Do **all** of these before writing the first line of production code (W1, Task T01).

1. **Verify domain `prix-bornes.fr` availability** at registrar of choice (OVH or Gandi, both French and ICANN-accredited). If unavailable, register the next viable: `prix-bornes.app`, `prixbornes.fr`, `prix-bornes.eu`. Squat-protect the alternates if budget allows (~€10/year each).
2. **Register the chosen domain** for 2 years upfront (anti-loss insurance). Enable WHOIS privacy. Enable registrar 2FA.
3. **Cloudflare account** (free tier). Add the domain. Switch nameservers at registrar.
4. **Cloudflare Email Routing** — create `corrections@prix-bornes.fr` → forwarded to your personal mailbox. Free, no MX setup needed beyond Cloudflare's auto-config. Also create `contact@`, `abuse@`, `noreply@`.
5. **GitHub organization or personal account** decision. Recommend personal for solo project (move to org if/when team forms). Create the **public** repository: `prix-bornes/prix-bornes` (or `<your-handle>/prix-bornes`). Description: "Comparateur public et neutre de tarifs des bornes de recharge en France." Default branch `main`.
6. **Repository skeleton** committed via local `git init` then `git push -u origin main`:
   - `README.md` — mission, data sources with attribution, contributing policy, `corrections@` email, link to `docs/`
   - `LICENSE` — `AGPL-3.0` (per Phase 2 acknowledgement #3) — code license only
   - `LICENSE-DATA` — `CC-BY-4.0` text — for the published normalized dataset
   - `CONTRIBUTING.md` — bug reports, parser fixture submissions, code conduct (referenced from README)
   - `.gitignore` — `node_modules/`, `.next/`, `.env*` (except `.env.example`), `.cache/`, `.vercel/`, `*.log`, `.DS_Store`
   - `docs/` — copy of the 3 phase docs for posterity
7. **Supabase account** at supabase.com. Create project `prix-bornes` in region `eu-west-3` (Paris). **Free tier** to start; upgrade to Pro ($25/mo) deferred until ~month 6 (per Phase 2 §3.2). Save the project's `Project URL`, `anon key`, `service_role key`.
8. **Supabase: enable PostGIS** via Dashboard → Database → Extensions → search "postgis" → enable. Also enable `pgcrypto` (for `gen_random_uuid()`).
9. **Supabase: create three schemas** via SQL Editor: `CREATE SCHEMA live; CREATE SCHEMA staging; CREATE SCHEMA archive;`. Note: this is *namespacing*, distinct from migration content (see §4).
10. **Vercel account** at vercel.com. Connect to GitHub. Import the repo. Pick framework "Next.js" (auto-detected). Region: `cdg1` (Paris) for functions. Don't deploy yet — no code.
11. **Vercel environment variables** (set on the project, all three environments — Production, Preview, Development):
    - `SUPABASE_URL` — from step 7
    - `SUPABASE_SERVICE_ROLE_KEY` — from step 7 (Production + Preview only; never Development)
    - `SUPABASE_ANON_KEY` — from step 7
    - `BAN_USER_AGENT` — `Prix-Bornes/1.0 (+https://prix-bornes.fr/about)` (BAN doesn't require a key but logs UA)
    - `INTERNAL_VIEWER_USER` / `INTERNAL_VIEWER_PASSWORD` — basic-auth creds for W5 viewer
    - `SENTRY_DSN` — from step 13
12. **GitHub repository secrets** (used by Actions for the IRVE pipeline):
    - `SUPABASE_DB_URL` — direct Postgres connection string (Settings → Database → Connection string → URI, "Connection pooling" off for COPY)
    - `SUPABASE_SERVICE_ROLE_KEY`
    - `SENTRY_DSN`
    - `IRVE_RESOURCE_ID` — pinned to `eb76d20a-8501-400e-b336-d85724de5435` (allows easy override if data.gouv.fr re-issues the resource)
13. **Sentry account** (free tier). Create project, runtime "Next.js". Copy DSN to step 11 + 12.
14. **Local toolchain** (verify each):
    - `node --version` ≥ 20 (LTS 22 preferred). Use `mise` or `nvm` to pin in repo.
    - `pnpm --version` (preferred over npm for this stack)
    - `gh --version` (GitHub CLI, for repo + Actions ops)
    - `vercel --version` (Vercel CLI, **upgrade to v53.1.0+** per session reminder: `pnpm add -g vercel@latest`)
    - `supabase --version` (Supabase CLI)
    - `psql --version` (Postgres client, for ad-hoc inspection)
    - `python3 --version` ≥ 3.11 (for the Phase 1 CSV scan tooling, kept under `tools/`)
15. **BAN API verification.** No key required. Confirm rate-limit policy: api-adresse.data.gouv.fr docs request *"max ~50 req/s, polite usage encouraged."* Our backfill runs at 10 req/s with 100-row batches. Document this in `docs/integrations/ban.md` (W1 task).
16. **AGPL-3.0 + CC-BY-4.0 text files** committed verbatim. AGPL from `https://www.gnu.org/licenses/agpl-3.0.txt`. CC-BY from `https://creativecommons.org/licenses/by/4.0/legalcode.txt`.
17. **Local `.env.example`** committed with the variable *names* (no values) matching step 11, plus a `DATABASE_URL` line for local dev pointing at a Supabase branch DB or local Postgres.
18. **Vercel preview branch protection.** GitHub Settings → Branches → `main` requires PR + 1 review (self-approve OK for solo) + Vercel preview check pass. Prevents accidental direct pushes to main without preview verification.

**Optional but recommended:**
- 19. **Plausible Analytics** or **Vercel Analytics** decision deferred to M1.5; M1 viewer is internal-only.
- 20. **Discord/Slack webhook** for `ingestion_runs` failures, configured in Sentry as a notification target.

---

## §2 — Schema migration plan

All migrations live under `supabase/migrations/` and are checked into git. Numbered, ordered. The `tariff_history` partitioning is **migration 0006 with monthly partitions, NOT an afterthought** (per your acknowledgement #1).

| # | File | Purpose |
|---|---|---|
| 0001 | `0001_extensions.sql` | `CREATE EXTENSION postgis; CREATE EXTENSION pgcrypto;` and `CREATE SCHEMA staging; CREATE SCHEMA archive;` (live = `public`). |
| 0002 | `0002_identity.sql` | `operators`, `networks`, `stations` (with `geography(Point,4326)` + `GIST` index), `charge_points`. PK on `stations.id_station_itinerance`. |
| 0003 | `0003_payment_methods.sql` | `payment_methods` enum + lookup, `pass_providers`, `subscriptions`, `pass_markups`. |
| 0004 | `0004_tariffs.sql` | `tariffs`, `tariff_elements`, `price_components`, `tariff_restrictions`. Currency, VAT, OCPI enums. |
| 0005 | `0005_provenance.sql` | `sources` (seed rows: `irve_consolidated`, `driveco_irve_json`, `citeos_template_parser`, `regex_kwh_parser`, `url_extractor`, `sentinel_detector`, `fastned_scraper`, `electra_scraper`, `chargemap_pass_scraper`, `operator_correction`). `station_tariffs` join with `confidence` enum + CHECK constraint `(confidence='unknown') = (tariff_id IS NULL)`. |
| 0006 | `0006_tariff_history_partitioned.sql` | `tariff_history` as `PARTITION BY RANGE (snapshot_at)`. Pre-create partitions for current month + next 11 months. Plus a pg_cron (or GitHub Action) job to roll a new partition on the 25th of each month. |
| 0007 | `0007_audit.sql` | `ingestion_runs`, `parser_outcomes` (one row per IRVE pdc per parser run, append-only), `geocode_cache` keyed by `id_pdc_itinerance`. |
| 0008 | `0008_corrections.sql` | `corrections` table per Phase 2 acknowledgement A3. Trigger that on insert/update of a correction row, upserts a `station_tariffs` row with `source='operator_correction'` and `confidence='verified'`. |
| 0009 | `0009_community_reports_skeleton.sql` | `community_reports` schema only. No triggers, no ingestion path, no UI in M1. |
| 0010 | `0010_indexes.sql` | Practical query indexes: `stations USING GIST (geom)`, `station_tariffs (station_id, payment_method_id)`, `parser_outcomes (raw_input_hash)`, `tariff_history (station_id, snapshot_at DESC)`. Run after data load to avoid double-write cost during initial import. |

**Migration runner.** Drizzle Kit for code-side schema definitions, Supabase CLI (`supabase db push`) for actual application. Both check that migrations are applied in order via the `supabase_migrations.schema_migrations` table.

---

## §3 — Task breakdown (M1, dependency order)

**Notation.** Complexity: **S** = ≤3h, **M** = 3–8h, **L** = 8h+ (flagged for splitting). Dependencies cited as `T0X`. Acceptance criteria are testable / observable, never "looks right."

### Weekend 1 — Bootstrap + skeleton

**T01 — Repo + Next.js scaffold + Vercel link** (S)
- *Scope.* `pnpm create next-app@latest prix-bornes --ts --app --tailwind --eslint --src-dir --turbopack --no-import-alias`. Add Drizzle, Zod, Sentry, Supabase JS. Configure `vercel.ts` (TypeScript Vercel config per platform reminder).
- *Acceptance.* `pnpm install && pnpm build` succeeds locally. `vercel link` connects to project. A trivial `/api/healthz` route returns `200 {ok:true}` on a Vercel preview URL. Sentry receives a thrown test error.
- *Files.* `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `next.config.ts`, `vercel.ts`, `src/app/api/healthz/route.ts`, `src/lib/sentry.ts`, `.env.example`.
- *Depends.* Day-1 checklist complete.

**T02 — Supabase client + Drizzle config** (S)
- *Scope.* Drizzle config pointing at `SUPABASE_DB_URL`. Two clients: server-side `db` (service-role) and read-only `dbReadOnly` for API routes.
- *Acceptance.* `pnpm drizzle-kit introspect` runs against the empty Supabase database without error.
- *Files.* `drizzle.config.ts`, `src/lib/db/index.ts`, `src/lib/supabase/server.ts`.
- *Depends.* T01.

**T03 — README + LICENSE + CONTRIBUTING + docs/ commit** (S)
- *Scope.* Per Day-1 step 6 + 16. README explicitly cites the IRVE source and `corrections@` mailbox.
- *Acceptance.* GitHub repo public, README renders cleanly with the data-source attribution block visible above the fold.
- *Files.* `README.md`, `LICENSE`, `LICENSE-DATA`, `CONTRIBUTING.md`, `docs/01-discovery.md` … `docs/03-implementation-plan.md`.
- *Depends.* none.

### Weekend 2 — Schema + IRVE ingestion

**T04 — Migrations 0001–0005 + seed rows for `sources`** (M)
- *Scope.* Author and apply migrations 0001–0005 from §2. Seed `sources` table with the 10 source slugs. Verify via `psql \dt+`.
- *Acceptance.* All five tables exist with declared constraints. CHECK constraint on `station_tariffs.confidence` rejects an INSERT with `confidence='verified', tariff_id=NULL`.
- *Files.* `supabase/migrations/0001..0005*.sql`, `src/lib/db/schema/*.ts` (Drizzle mirror).
- *Depends.* T02.

**T05 — Migrations 0006–0010 (history, audit, corrections, indexes)** (M)
- *Scope.* Author migrations 0006–0010. The `tariff_history` partitioning is the most subtle — pre-create 12 monthly partitions, write the rollover job as a GitHub Action that runs on the 25th of each month and creates the next +1 month.
- *Acceptance.* Inserting a row into `tariff_history (snapshot_at = NOW())` lands in the current-month partition (verify with `EXPLAIN`).
- *Files.* `supabase/migrations/0006..0010*.sql`, `.github/workflows/partition-rollover.yml`.
- *Depends.* T04.

**T06 — IRVE download + stage + diff-and-swap (the spine)** (L → split into T06a + T06b)

- **T06a — Download + stream-parse to `staging`** (M)
  - *Scope.* GitHub Action `irve-sync.yml` runs daily at 02:00 Europe/Paris. Downloads the CSV from the pinned resource ID, computes SHA, aborts early if unchanged. Streams CSV into `staging.irve_raw` via `psql \copy`.
  - *Acceptance.* Action runs end-to-end on demand (workflow_dispatch), `staging.irve_raw` contains 224k+ rows, the run logs total time and row count.
  - *Files.* `.github/workflows/irve-sync.yml`, `tools/irve-sync/main.py` (Python script — better at streaming CSV + Postgres COPY than Node).
  - *Depends.* T04, Day-1 step 12.
- **T06b — Diff-and-swap to `live` + `ingestion_runs` write** (M)
  - *Scope.* SQL functions `live.upsert_stations_from_staging()` and `live.upsert_charge_points_from_staging()`. UPSERT logic on PKs, mark unseen rows. Also writes one row to `ingestion_runs` with status, counts, durations.
  - *Acceptance.* After two consecutive runs (one with manual edits to `staging`), `live.stations` has the expected delta and `ingestion_runs` shows two completed rows.
  - *Files.* `supabase/migrations/0011_irve_swap_functions.sql`, `tools/irve-sync/main.py` (extended).
  - *Depends.* T06a.

### Weekend 3 — Geocoding + dedup

**T07 — BAN reverse-geocoding + `geocode_cache`** (M)
- *Scope.* Standalone GitHub Action `geocode-backfill.yml` (workflow_dispatch initially). Pulls all `live.stations` rows where `consolidated_code_postal IS NULL`, batches them in groups of 100 to BAN's `/reverse` endpoint, writes results to `geocode_cache`, then UPDATEs `live.stations` with the resolved postal/commune. Throttled to 10 req/s.
- *Acceptance.* After one full run on the ~95k missing-postal rows, ≥95% have a populated postal code. Cache hit on second run.
- *Files.* `.github/workflows/geocode-backfill.yml`, `tools/geocode/main.py`, `docs/integrations/ban.md`.
- *Depends.* T06b.

**T08 — Enseigne canonicalization + operator dedupe** (S)
- *Scope.* SQL view + manual mapping table `operator_aliases (alias_text PRIMARY KEY, operator_id)` populated with the known duplicates from Phase 1 A.1: "LIDL"/"Lidl France" → operators row "Power Dot (Lidl)"; "Tesla"/"TESLA SUPERCHARGER" → "Tesla Supercharger"; etc. UPSERT trigger on `live.stations` resolves enseigne → `operator_id` via the map.
- *Acceptance.* `SELECT COUNT(DISTINCT operator_id) FROM live.stations` is materially smaller than `COUNT(DISTINCT nom_enseigne)`. The 15 brands from Phase-1 A.1 each map to exactly one operator row.
- *Files.* `supabase/migrations/0012_operator_aliases.sql`, seed data file.
- *Depends.* T06b.

### Weekend 4 — Parser pipeline (the freebies)

**T09 — `P5` sentinel detector** (S)
- *Scope.* Pure TS function. Returns `'unknown'` for the sentinel set: empty, `-`, `TRUE`, `FALSE` (case-insensitive), `Inconnu`, `N/A`, `/`, `Au kWh`, `FIXE`, the 12,890-row meta-disclaimer (matched by length+prefix).
- *Acceptance.* All 5 fixtures in `tests/fixtures/parsers/sentinel/` (per §5) classify as `unknown`. The 12,890-row Power Dot disclaimer classifies as `unknown`.
- *Files.* `src/lib/parsers/sentinel.ts`, `tests/parsers/sentinel.test.ts`, `tests/fixtures/parsers/sentinel/*.json`.
- *Depends.* T04 (needs `confidence` enum to exist).

**T10 — `P0` DRIVECO JSON parser** (S)
- *Scope.* Try-parse JSON. If shape matches `{energyPrice, fixedPrice, matrixOSF}`, emit OCPI tariff: ENERGY component at `energyPrice` €/kWh, optional FLAT at `fixedPrice`, PARKING_TIME components per `matrixOSF` entry (price + grace = `min_duration`). All 5 known schemas covered.
- *Acceptance.* All 5 fixtures (§5) parse to OCPI tariffs whose total per-kWh cost matches the manual hand-derivation.
- *Files.* `src/lib/parsers/driveco.ts`, `tests/parsers/driveco.test.ts`, `tests/fixtures/parsers/driveco/*.json`.
- *Depends.* T09.

**T11 — `P1` CITEOS template parser** (M)
- *Scope.* Tokenize on commas, recognize "entre HH:MM et HH:MM", "par défaut", "X€ par kwh de charge", "X€ par heure d'occupation hors charge", "X€ par heure de charge". Tolerate the misplaced-comma bug observed in Phase 1 (`"par heure ,'occupation"`). Build a TariffElement per time-window with ENERGY + TIME + PARKING_TIME components.
- *Acceptance.* All 5 fixtures parse cleanly. The bug-pattern fixture parses with a logged warning, not a parse failure.
- *Files.* `src/lib/parsers/citeos.ts`, `tests/parsers/citeos.test.ts`, `tests/fixtures/parsers/citeos/*.json`.
- *Depends.* T09.

### Weekend 5 — Long tail + first scraper + viewer

**T12 — `P2` regex €/kWh parser** (M)
- *Scope.* Multi-pattern regex: `(\d+[.,]\d+)\s*(€|cts?|euros?)\s*[/\s]+(?:k?w?h)`. Disambiguate cts vs €. Handle "AC: ... / DC: ..." power split. Handle multi-clause "0,32€/Kwh + 0,1€/min" by chained component emission.
- *Acceptance.* 5 fixtures parse. Unit ambiguity (`'0,30cts/KWh'` — observed in Phase 1, EVBOX) flagged with `confidence='parsed'` but a warning row in `parser_outcomes`.
- *Files.* `src/lib/parsers/regex-kwh.ts`, `tests/parsers/regex-kwh.test.ts`.
- *Depends.* T11.

**T13 — `P3` URL extractor + parser pipeline orchestrator** (S)
- *Scope.* Detect URL-only values, extract URL, store in `stations.tariff_url`. Pipeline orchestrator chains `P5 → P0 → P1 → P2 → P3 → fallback unknown`, emitting one `parser_outcomes` row per IRVE row. Wire to T06b (call after the swap).
- *Acceptance.* Running the full pipeline against the loaded `live.stations` populates `station_tariffs` for ≥10% of stations with `confidence IN ('parsed','unknown')` and `parser_outcomes` for 100% of rows.
- *Files.* `src/lib/parsers/url.ts`, `src/lib/parsers/pipeline.ts`, `tools/run-parsers.ts` (one-shot).
- *Depends.* T12.

**T14 — `fastned_scraper` (the verified-tier seed)** (M)
- *Scope.* Vercel Cron route `/api/cron/scrape-fastned` (weekly Mon 04:00). Fetches https://www.fastnedcharging.com/en/charging/tariffs and /hq/en/charge-price-changes. Parses HTML for FR-row tariffs (CB direct, Gold subscription, app payment). Writes 3 rows to `tariffs` + N to `station_tariffs` for every Fastned-enseigne station, `confidence='verified'`.
- *Acceptance.* After one cron run, every Fastned-enseigne station has 3 `station_tariffs` rows with `confidence='verified'` and `last_verified_at` within the last hour.
- *Files.* `src/app/api/cron/scrape-fastned/route.ts`, `src/lib/scrapers/fastned.ts`, `tests/scrapers/fastned.test.ts`, `tests/fixtures/scrapers/fastned/*.html` (captured page snapshot).
- *Legal posture.* Robots.txt: `Allow: /` confirmed Phase 1 A.2. We honor `Crawl-delay` if added. UA: `Prix-Bornes/1.0 (+https://prix-bornes.fr/about)`. **If page structure changes** → scraper test fails in CI → `is_enabled=false` via SQL → ship parser fix → re-enable. **If robots.txt becomes restrictive** → disable scraper, fall back to "see operator" link.
- *Depends.* T13, Day-1 step 11 (cron config in `vercel.ts`).

**T15 — Internal viewer (the M1 demo)** (M)
- *Scope.* Page `/internal/search` behind Edge Middleware basic auth (`INTERNAL_VIEWER_USER`/`PASSWORD`). Form: address text input → BAN autocomplete (`/api/internal/ban-autocomplete` Server Action) → on submit, server-render a table of the 10 nearest stations from `live.stations` ordered by ST_Distance, with their best-known tariff per `station_tariffs` (confidence-priority sort).
- *Acceptance.* Typing "Wasquehal" returns ≤2s a page listing 10 stations with at least: name, distance (km), max power, the best-confidence tariff with its badge, last_verified_at. Visible from a Vercel preview URL after basic-auth.
- *Files.* `src/app/internal/search/page.tsx`, `src/app/internal/search/_actions.ts`, `src/middleware.ts`, `src/lib/ban/autocomplete.ts`, `src/components/internal/StationTable.tsx`.
- *Depends.* T14 (so the demo includes verified rows). If T14 slips, T15 demos with `parsed` rows only and a TODO badge — still acceptable.

---

## §4 — Total M1 effort and reconciliation with Phase 2

| Weekend | Tasks | Sum complexity | Realistic h |
|---|---|---|---|
| W1 | T01 (S) + T02 (S) + T03 (S) | 3×S = ~6h | 6–8h |
| W2 | T04 (M) + T05 (M) + T06a (M) + T06b (M) | 4×M = ~24h | 16–20h (some overlap) |
| W3 | T07 (M) + T08 (S) | M+S = ~10h | 8–10h |
| W4 | T09 (S) + T10 (S) + T11 (M) | 2×S+M = ~12h | 10–12h |
| W5 | T12 (M) + T13 (S) + T14 (M) + T15 (M) | 3×M+S = ~22h | 16–20h |

**Total: ~60–80h, mapping to 5 weekends as estimated in Phase 2 §5.1.** Honest caveat: W2 is the hardest weekend by a margin (4 medium tasks, the IRVE spine is gnarly). If W2 overflows, push T08 from W3 → W2 spillover and let W3 absorb only T07.

**No tasks exceed L complexity** after the T06 split. **No single weekend exceeds the 3-weekend-per-task cap** (irrelevant — that cap is per-milestone, but per-weekend we're under the implicit limit too).

**If we slip beyond 5 weekends**, the candidates to cut from M1 (and push to M1.5) are, in cut order:
1. T14 `fastned_scraper` — the viewer can demo with parsed-only rows and a "verified scraper coming next week" banner. Saves ~4h.
2. T08 enseigne canonicalization — annoying but cosmetic for the internal viewer. Saves ~2h.
3. T07 BAN backfill could be split: do the *forward* geocoding (search input) in M1, defer the historical *reverse* geocoding backfill to W6. Saves ~6h, costs UI completeness.

---

## §5 — Parser test fixtures from real IRVE rows

Fixtures live under `tests/fixtures/parsers/<parser>/`. Each is a JSON file with shape:
```json
{
  "id_pdc_itinerance": "FRDRVE11657P1",
  "enseigne": "DRIVECO / DRIVECO",
  "raw": "...verbatim tarification value...",
  "expected": { "confidence": "parsed", "components": [...] }
}
```

All `id_pdc_itinerance` values below are confirmed to exist in the local CSV cache as of 2026-05-02 (Phase 3 verified by direct CSV scan).

### P5 sentinel — 5 fixtures

| Fixture | Source enseigne | Raw value |
|---|---|---|
| `sentinel/empty.json` | various | `""` |
| `sentinel/dash.json` | various | `"-"` |
| `sentinel/bool-true.json` | various (455 rows total) | `"TRUE"` |
| `sentinel/inconnu.json` | various (1,850 rows) | `"Inconnu"` |
| `sentinel/meta-disclaimer.json` | Power Dot France (12,890 rows) | `"Les tarifs de recharge peuvent varier en fonction de plusieurs facteurs, y compris le fournisseur de services, l'emplacement de la borne, la puissance de charge, et les éventuelles promotions en cours..."` |

### P0 DRIVECO JSON — 5 fixtures (real `id_pdc_itinerance` confirmed in cache)

| Fixture | id_pdc_itinerance | Notes |
|---|---|---|
| `driveco/standard-049.json` | (sample from `FRDRVE*P1`) | `energyPrice=0.49`, single matrixOSF tier |
| `driveco/standard-054.json` | `FRDRVE113231837981051962P1` | `energyPrice=0.54`, two-tier matrixOSF (graceful idle) |
| `driveco/standard-039.json` | `FRDRVE11657P1` | `energyPrice=0.39` |
| `driveco/standard-051.json` | (any `*"energyPrice":0.51*`) | `energyPrice=0.51`, single matrixOSF |
| `driveco/standard-030.json` | (any `*"energyPrice":0.3*`) | `energyPrice=0.3`, lowest observed price |

### P1 CITEOS template — 5 fixtures

| Fixture | id_pdc_itinerance | Notes |
|---|---|---|
| `citeos/region-bfc-time-windowed.json` | `FRBFCEVDIJZ1` | `entre 08:00 et 19:00 : 0.41667€...` |
| `citeos/region-bfc-permuted.json` | `FRBFCEVDIJZ1` (variant) | Same data, different field order — checks parser robustness |
| `citeos/mobive-2380a.json` | (`CPO CITEOS Mobive`) | `0.45833€` time-windowed |
| `citeos/par-defaut-only.json` | (`CPO CITEOS Mobive`) | No time window, only `par défaut` clauses (`0.4667€`) |
| `citeos/buggy-comma.json` | (`CPO CITEOS Vaucluse`) | Contains the upstream stringification bug `"par heure ,'occupation"` — must parse with warning, not crash |

### P2 regex €/kWh — 5 fixtures

| Fixture | Source enseigne | Raw value |
|---|---|---|
| `regex/electra-style-029.json` | various (3,569 rows) | `"0,29€ / kWh"` |
| `regex/mobilygreen-033.json` | Mobilygreen CPO | `"0.33€/kWh"` |
| `regex/evbox-cts-ambiguity.json` | EVBOX | `"0,30cts/KWh"` (must flag unit ambiguity in `parser_outcomes`) |
| `regex/multi-clause-edenauto.json` | Edenauto Toulouse | `"lorsque la voitutre est branché:on applique 0.32€/Kwh + 0.1€ /min ( App Tarif) lorsque la voiture est chargée mais toujours branché: on applique 0.1€/min (App tarif)"` |
| `regex/hpc-style.json` | TotalEnergies (613 rows) | `"HPC 49cts/Kwh"` |

### P3 URL extractor — 5 fixtures

| Fixture | Source enseigne | Raw value |
|---|---|---|
| `url/belib.json` | Belib' | `"https://belib.paris"` |
| `url/total-ev-charge.json` | TotalEnergies-affiliated | `"https://apps.total-ev-charge.com/charge-points"` |
| `url/ouestcharge.json` | Pays de la Loire | `"https://www.ouestcharge-paysdelaloire-moncompte.fr/fr/tarifs"` |
| `url/metropolis.json` | Metropolis | `"https://www.metropolis-recharge.fr/"` |
| `url/fuzed.json` | Fuzed | `"https://www.go-fuzed.com/cgv"` |

### Fastned scraper HTML fixtures

These are **not from the CSV** (Fastned does not populate the IRVE `tarification` field — confirmed by Phase 3 probe). Capture them on T14 from the live page:

| Fixture | Source URL | Notes |
|---|---|---|
| `fastned/fr-tariffs-snapshot-2026-05.html` | https://www.fastnedcharging.com/en/charging/tariffs | The tariff matrix as of W5 capture |
| `fastned/fr-price-changes-2026-05.html` | https://www.fastnedcharging.com/hq/en/charge-price-changes | The dated price-changes log |
| `fastned/fr-tariffs-mobile-snapshot-2026-05.html` | (mobile UA fetch) | Mobile rendering parity check |
| `fastned/fr-tariffs-with-promo.html` | (synthetic) | Manually edited to simulate a promotional banner — checks parser robustness |
| `fastned/fr-tariffs-empty.html` | (synthetic) | Empty matrix simulation — must fail loud, not silent |

### Electra, Power Dot, Chargemap fixtures

Out of M1 scope (Electra is W6+, Chargemap pass W7+, Power Dot via IRVE only). Their fixtures are listed for M1.5 implementation.

---

## §6 — Risk register for M1

| # | Risk | Likelihood | Impact | Escalation / fallback |
|---|---|:-:|:-:|---|
| R1 | **W2 IRVE pipeline blows past one weekend** (gnarliest single chunk) | **High** | Slips W3+ by 1 weekend each | If W2 not green by Sunday night, ship the simpler "truncate-and-reload" version (no diff-and-swap) for first sync; promote to diff-and-swap in W3 alongside T07. Costs us idempotency for one cycle. |
| R2 | **Fastned page structure changes between fixture capture and W5 ship** | Low–Medium | T14 misses W5 | Internal viewer demos with `parsed`-only rows + a "fastned scraper coming W6" banner. Push T14 to first task of M1.5. Per acceptance footnote on T15 — already designed for. |
| R3 | **BAN API rate-limits the 95k-row backfill** | Low | T07 takes 1–2 days wallclock | Throttle to 5 req/s, run as an overnight Action. Backfill is one-time; subsequent IRVE syncs only geocode delta (~hundreds/day). |
| R4 | **Supabase free tier hits row-count or storage cap during M1** | Low (M1 footprint ≈110 MB) | Forced upgrade | Pre-empt by disabling history-snapshot writes in M1 if storage approaches 400 MB. We're collecting `tariff_history` from W2 but not surfacing it; safe to pause. |
| R5 | **Schema drift in IRVE between W2 and W5** (e.g. v2.4.0 release) | Low | Validation warnings, possible column rename | Validate-but-don't-fail design from T06a. Unknown columns land in `staging.irve_raw_extra` JSONB. |
| R6 | **Domain `prix-bornes.fr` not available** | Medium | Day-1 unblocked elsewhere | Pre-checked alternates in Day-1 step 1. Even `prix-bornes.app` works for an internal viewer — only matters for branding at M1.5. |
| R7 | **Power Dot's 12,890-row meta-disclaimer treated as a real value by P5 by mistake** | Low (covered by fixture) | Visible: "parsed nonsense" in viewer | The fixture `sentinel/meta-disclaimer.json` enforces the prefix match in T09. CI test catches regressions. |
| R8 | **Electra scrape (M1.5 first task) turns out JS-heavy / behind cookie banner** | Medium | M1.5 Fastned-only | Drop Electra to M2 if not Mon-Sun-doable. Honest UX: "Electra tarifs disponibles dans l'app — voir lien." |
| R9 | **PostGIS extension activation glitch on Supabase free tier** | Low | T01 day-1 blocked | Open a Supabase support ticket; in interim, fall back to plain `numeric` lon/lat columns + haversine — slower, but unblocks dev. Re-enable PostGIS later via migration. |
| R10 | **Solo-dev fatigue in W4–W5** (the parser weekend is mentally taxing) | Medium | T11 or T12 slip | The parsers are ordered by importance: P5 + P0 are non-negotiable (sentinel + DRIVECO together cover ~77% of dataset). P1 (CITEOS) covers ~4% and is the dispensable one if energy depletes. |

---

## §7 — Definition of Done for M1

Verbatim per your direction, augmented with a few observable details:

- ✅ **Daily IRVE sync runs green for 7 consecutive days.** Verified via `SELECT COUNT(*) FROM ingestion_runs WHERE source_id = (SELECT id FROM sources WHERE slug='irve_consolidated') AND status='success' AND started_at > NOW() - INTERVAL '7 days'` returns ≥7.
- ✅ **All 5 priority operator scrapers run weekly *or* are explicitly disabled with a logged reason.** M1 ships only `fastned_scraper` enabled. Power Dot + DRIVECO entries in `sources` are rows with `kind='parsed_irve_field'` and `is_enabled=true` (no scraper, parsed via the pipeline). Electra + Chargemap pass scraper rows exist with `is_enabled=false` and `notes_url` pointing to a tracking issue for M1.5.
- ✅ **Reverse-geocoding fills postal code for ≥95% of historically-missing rows.** Verified via `SELECT 1 - (COUNT(*) FILTER (WHERE consolidated_code_postal IS NULL))::float / COUNT(*) FROM live.stations` returns ≥0.95.
- ✅ **Confidence tiers are populated correctly for every row in `station_tariffs`.** CHECK constraint enforces shape; observable test: `SELECT confidence, COUNT(*) FROM station_tariffs GROUP BY confidence` returns all four tiers and zero NULL.
- ✅ **Internal viewer page is reachable and returns results for "Wasquehal" in <2s** behind basic auth, on a Vercel preview URL. Measured via a Lighthouse run (TTFB + render).
- ✅ **Public repo has README, LICENSE, CONTRIBUTING, and `corrections@prix-bornes.fr` reachable.** Send a test email to `corrections@`, receive in your forwarding mailbox.
- ✅ **Public coverage stat available in chat, even if not rendered in UI.** `SELECT confidence, COUNT(*)::float / SUM(COUNT(*)) OVER () AS pct FROM station_tariffs GROUP BY confidence` — this becomes the `/qualite-des-donnees` page in M1.5.
- ✅ **Sentry receives at least one synthetic error from the production deployment**, confirming the alerting path works.
- ✅ **All migrations 0001–0012 applied to production Supabase**, recorded in `supabase_migrations.schema_migrations`.

If any one of these is red on the M1 sign-off date, M1 is not done.

---

## New open questions surfaced during planning

- **OQ1 — Drizzle vs Kysely vs raw SQL for the diff-and-swap functions.** I leaned on raw SQL (T06b) because the operations are pure UPSERT/MERGE that ORMs make awkward. Confirm OK? Trade-off: raw SQL is harder to refactor than Drizzle DSL but matches the level of abstraction the operation actually needs.
- **OQ2 — Cron scheduling source of truth.** Vercel crons live in `vercel.ts`. GitHub Actions crons live in workflow YAML. Two places. Should we consider a single cron orchestrator, or accept the two-system reality? My read: **accept**. Migrating one to the other costs more than the cognitive overhead.
- **OQ3 — Basic auth for the viewer.** Edge Middleware basic auth is fine for "Jules + 1 friend." If you want to share the W5 viewer with a 3rd person who shouldn't see your password, we'd need a real auth flow — and that's an M1 scope creep. Defer the question until first share request.
- **OQ4 — Dev DB strategy.** Do we develop against the production Supabase (with `staging.*` schema isolation) or run a local Postgres + PostGIS via Docker? My recommendation: production Supabase for M1 (faster bring-up, real data), local Postgres added in M1.5 if testing friction grows. Cost: any test that mutates `live.*` could affect the production internal viewer — but since the viewer is internal and we don't have users yet, harmless.
- **OQ5 — `vercel.ts` vs `vercel.json`.** Per session reminder, `vercel.ts` is the recommended modern format (TypeScript with `@vercel/config`). I've assumed `vercel.ts` throughout. Confirm OK to commit to it from W1 — adoption is recent enough that some docs still show `vercel.json`.
