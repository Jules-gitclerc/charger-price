# Migrations errata

This file is the paper trail for issues found in committed migrations that we explicitly chose **not** to fix retroactively. Append-only migration history binds. New migrations follow the documented forward practices below.

Each entry records: the T0N session in which the issue surfaced, what's wrong, why we didn't fix it in place, and what new migrations should do instead.

---

## E1 — `0001_extensions.sql` cites `AGENTS.md hard rule #6` but the rule isn't in `AGENTS.md`

- **Surfaced:** T04 (during 0002 review).
- **What's wrong:** The header of `supabase/migrations/0001_extensions.sql` cites `AGENTS.md hard rule #6` as the source of the "never write to `public`" rule. `AGENTS.md` actually only contains the Next.js framework note; the rule originated in the T04 session brief.
- **Action taken:** None — append-only migration history.
- **Forward practice:** Cite `T04 session brief hard rule #N` (or `T05 brief …`) when referencing prompt-derived rules. Cite `AGENTS.md §<section>` only when referencing actual AGENTS.md content.

## E2 — Pre-T04 plan-doc convention drift on `live` vs `public`

- **Surfaced:** T04 (during 0001 drafting).
- **What's wrong:** `docs/02-architecture.md` §2 originally contained a "live = `public`" comment. The T04 brief overrode this with hard rule #6 ("never write to `public`"). 0001 documents the supersession but earlier doc references may still read otherwise.
- **Action taken:** None — neither the migration nor the doc rewritten.
- **Forward practice:** Application data lives in `live.*`. `staging.*` is per-run scratch (T06+ ingestion). `archive.*` is cold storage (≥12-month-old rows). `public.*` is reserved for PostGIS system tables and Supabase-managed objects.

## E3 — Index naming convention inconsistency across 0001–0009

- **Surfaced:** T05 (during 0010 D3 design call review).
- **What's wrong:** Three naming patterns coexist:
  - `<table>_<col>_idx` (e.g. `charge_points_station_idx`, `parser_outcomes_hash_idx`)
  - `<table>_<purpose>_idx` (e.g. `corrections_pending_queue_idx`, `station_tariffs_active_idx`)
  - `<table>_<col>_<suffix>` without `_idx` (e.g. `stations_geom_gist`)
- **Action taken:** None — append-only history binds.
- **Forward practice:** New indexes should follow the `_idx` suffix convention. Use `<table>_<purpose>_idx` for partial / multi-column indexes whose intent isn't obvious from the column list; use `<table>_<col>_idx` for plain single-column ones.

## E4 — Trigger inventory row count vs logical count confusion (T04 closing)

- **Surfaced:** T04 (closing summary).
- **What's wrong:** The T04 closing summary reported "13 logical triggers" post-0005, while `information_schema.triggers` returned 14 rows. Both are correct readings, but the gap is a source of confusion: Postgres splits compound `BEFORE INSERT OR UPDATE OF subscription_id` triggers into one `information_schema.triggers` row per `event_manipulation` value, even though it's a single named trigger.
- **Action taken:** None — closing summaries since clarified the convention.
- **Forward practice:** When reporting trigger counts, query `COUNT(DISTINCT trigger_name)` for the logical count; mention the row-count gap when it exists.

## E5 — T04 closing logical-table count off by 1

- **Surfaced:** T05 (during 0007 verification).
- **What's wrong:** The T04 closing summary said "14 tables" post-0006, but the true count was 15 (forgot to add the partitioned `tariff_history` parent). Caused a `expected 16, got 17` discrepancy at the top of 0007's verification.
- **Action taken:** None — corrected in 0007's report.
- **Forward practice:** When 0006-style partitioned-parent tables land, count the parent in the logical-table total; don't count partition leaves.

## E6 — Two false-positive C-blockers from chat-paste rendering loss

- **Surfaced:** T04 (during 0003 review) and T05 (during 0005 review).
- **What's wrong:** The chat paste of a migration body lost lines on the user's view that were intact on disk. Each false positive was diagnosed via `git show <sha>:<path>` / direct file Read on disk. Sqlfluff would not have caught either case because both files were actually correct; the failures were render-side artifacts.
- **Action taken:** None on the migrations themselves (which were always correct).
- **Forward practice (adopted T05 onwards):** Default chat protocol is "summary + design calls + diff" not "full SQL body paste." Full file paste is the exception, requested explicitly. The full-file path through `git show <sha>:<path>` (post-commit) or local file Read (pre-commit) is the source of truth. See also the `libpg_query` pre-commit gate (W3 mid-week side commit) for the orthogonal sqlfluff-blind-spot case.

## E7 — IRVE schema-version drift JSONB bucket forward practice

- **Surfaced:** T06a (during 0011 drafting).
- **What's wrong:** Migration 0011 declares all 40 v2.3.0 spec columns + 12 consolidation extras as `text` columns plus `_extra_columns jsonb` for v2.4.x drift. When upstream Etalab adds a new column, the runner currently captures it inside `_extra_columns` rather than promoting it to a typed column.
- **Action taken:** None — drift bucketing is by design, not an issue to fix in 0011.
- **Forward practice:** Any spec column added by Etalab gets a hand-authored migration (alter from JSONB drift bucket → typed text column); never auto-promote. JSONB capture is the safe-by-default behavior so a runner version doesn't break on upstream additions, but typed columns are the long-term destination once the new column's semantics are reviewed.

## E8 — `live.ingestion_runs.git_sha` semantics

- **Surfaced:** T06a (during step-3 wiring review).
- **What's wrong:** `live.ingestion_runs.git_sha` represents the runner version (commit SHA of the GitHub Actions checkout, i.e. `${{ github.sha }}`), not the data version. The data version's hash lives in `staging.ingestion_run_meta.last_sha`. Both are SHAs and both relate to a run, which can read as conflated.
- **Action taken:** None — both columns are correct as designed; the asymmetry is documented here so future readers don't conflate them.
- **Forward practice:** When debugging an ingestion run, `git_sha` answers "what code ran"; `last_sha` answers "what bytes were ingested". Don't conflate. New ingestion sources should follow the same split: runner version on `ingestion_runs`, data version on `ingestion_run_meta`.

## E9 — Phase 1 §A.1 column count off by one

- **Surfaced:** T06a (during 0011 drafting).
- **What's wrong:** `docs/01-discovery.md` §A.1 reported 41 spec + 10 extras = 51 columns. Actual at T06a authorship: 40 spec + 12 extras = 52 columns.
- **Action taken:** None — drift gets logged in the runner's first-line output (`# header columns: 52`, drift columns enumerated). Phase 1 doc not amended.
- **Forward practice:** Don't amend `docs/01-discovery.md` retroactively. Runner output is the source of truth for current column inventory.

## E10 — Day-1 step 12 direct-connection assumption

- **Surfaced:** T06a (during step-3 setup).
- **What's wrong:** Day-1 setup notes assumed direct Postgres connection (port 5432, `db.<ref>.supabase.co`). 2026-vintage Supabase free tier no longer offers IPv4 dual-stack on direct; the working URL for `SUPABASE_DB_URL` is the **session pooler** (`aws-1-eu-west-3.pooler.supabase.com:5432`, IPv4-friendly, supports COPY).
- **Action taken:** T06b.2.a updated `tools/irve-sync/main.py` docstring to remove direct-connection language. Day-1 doc itself not retroactively edited.
- **Forward practice:** For COPY-using workloads, use the session pooler URL (port 5432 on `pooler.supabase.com`). The transaction pooler (port 6543) is not safe for COPY. Direct connection is blocked on free tier. **Important verification:** `SUPABASE_DB_URL` is session pooler, not direct — verify before any new ingestion runner.

## E11 — IRVE row count volatility

- **Surfaced:** T06a (first real run, 2026-05-03).
- **What's wrong:** Phase 1 §A.1 reported 224,467 rows; T06a first real run loaded 211,708 (-5.7% in 24h). Day-to-day drift is normal in IRVE consolidated CSV.
- **Action taken:** None — runner output is the source of truth for current row count.
- **Forward practice:** Never hardcode 224k or any specific row count in code, tests, or docs. 211,708 is the T06a-day baseline; expect daily drift of several percent.

## E12 — Pooler stdout command-tag leakage

- **Surfaced:** T06a (step-3 first real run, workflow run 25278077390).
- **What's wrong:** Supavisor session pooler in `psql -tA` mode emits command tags (`INSERT 0 1`, `UPDATE n`, `BEGIN`, `COMMIT`, …) on stdout alongside result tuples. Direct connection suppresses them; the pooler does not. Caused multi-line UUID returns from `_open_run_row` in T06a, which poisoned every staging row's `_ingestion_run_id` and broke `\copy`.
- **Action taken:** T06a hotfix in commit `0a3b53d` added `_PSQL_TAG_RE` filter to `_psql`.
- **Forward practice:** Any T06+ shellout to psql via the pooler must go through `_psql` / `_psql_no_raise` (or equivalent stdout filtering). Helpers calling psql directly without the filter are forward bugs.

## E13 — `_PSQL_TAG_RE` invariant

- **Surfaced:** T06a (commit `0a3b53d`); reaffirmed T06b.2.
- **What's wrong:** Building on E12 — the regex filter in `_psql` (`^(?:INSERT \d+ \d+|UPDATE \d+|DELETE \d+|SELECT \d+|MERGE \d+|COPY \d+|TRUNCATE TABLE|BEGIN|COMMIT|ROLLBACK)$`) is a binding contract for any psql shellout from this codebase forward.
- **Action taken:** None — already enforced in `_psql` and `_psql_no_raise`.
- **Forward practice:** New psql shellout helpers MUST inherit this filter. Direct `subprocess` calls to `psql` outside the helpers are forward bugs.

## E14 — Phase-3 plan migration numbering off by one

- **Surfaced:** T06b.1 (during 0012 drafting).
- **What's wrong:** `docs/03-implementation-plan.md` named the swap-functions migration "0011". Reality: 0011 = staging tables (T06a), 0012 = swap functions (T06b.1).
- **Action taken:** None — plan not retroactively edited.
- **Forward practice:** Plan-doc migration numbers are best-effort estimates from Phase 3; don't rely on them for cross-reference. Use commit messages and migration headers (which cite preceding migrations by exact number) for authoritative wiring.

## E15 — Failure-path closure separate from rolled-back txn

- **Surfaced:** T06b.1 (during 0012 design).
- **What's wrong:** `live.run_irve_swap` runs in the caller's transaction with no internal `EXCEPTION` block. If the swap raises, the transaction rolls back — including any attempt to close the `live.ingestion_runs` row to `'failed'` from inside the function. The closure must therefore be a **separate post-rollback statement** issued by the caller after the swap txn rolls back.
- **Action taken:** Encoded in `live.run_irve_swap`'s contract (no internal EXCEPTION block); enforced in `tools/irve-sync/main.py`'s failure-path branch via a `_psql` call to `live.close_ingestion_run('failed', …)` after `_psql_no_raise(SELECT live.run_irve_swap(…))` returns rc!=0.
- **Forward practice:** Any future ingestion swap function follows the same pattern: caller-controlled txn, no internal EXCEPTION, terminal-status close issued by caller post-rollback on failure. Internal `PERFORM live.close_ingestion_run(…)` to the success / partial status is fine — it runs in the same txn that ultimately commits.

## E16 — Soft-delete only in M1

- **Surfaced:** T06b.1 (during 0012 design).
- **What's wrong / forward practice:** Forbid `DELETE FROM live.stations` and `DELETE FROM live.charge_points` until M2. Stations and PDCs not seen in a swap retain their previous `last_seen_in_irve_at` timestamp; nothing is removed. M2 will surface "stations gone for ≥N runs" via `WHERE last_seen_in_irve_at < threshold` queries, decoupling visibility from data deletion.
- **Action taken:** 0012's swap functions are upsert-only; no DELETE path exists.

## E17 — IRVE PDC-level duplicates and sentinel PKs (Phase 1 audit missed)

- **Surfaced:** T06b.1 (0012 first apply, SQLSTATE 21000).
- **What's wrong:** 26.4% of staging rows had PDC IDs that were either operator-side duplicates of legitimate FR-prefixed IDs or sentinel placeholders (119 rows with `'Non concerné'`). Phase 1 §A.1 assumed `id_pdc_itinerance` was a stable PK without verifying uniqueness. 0012's `ON CONFLICT DO UPDATE` against `live.charge_points.id_pdc_itinerance` raised SQLSTATE 21000 ("ON CONFLICT DO UPDATE cannot affect row a second time") on first apply.
- **Action taken:** Migration 0013 corrects via positive-format ID filter (regex-rejecting whitespace-bearing values like `'Non concerné'` on both `id_pdc_itinerance` and `id_station_itinerance`) plus `DISTINCT ON (id_pdc_itinerance)` dedupe in `valid_pdcs` with `date_maj DESC NULLS LAST` tiebreak.
- **Forward practice:** Any ingestion using IRVE national IDs as conflict keys MUST positive-match on format AND dedupe via DISTINCT ON before UPSERT. Phase 1 audits missed this because they sampled distinct values without measuring per-key cardinality.

## E18 — IRVE consolidated CSV contains non-French operator rows (Phase 1 audit missed)

- **Surfaced:** T06b.1 (during 0013 audit).
- **What's wrong:** ~382 single-occurrence rows from Belgian DRIVECO (`BE...`) and Austrian HTB (`AT...`) silently included in the consolidated CSV. Phase 1 §A.1 scoped DOM-TOM via postal code (97xxx) but never checked `id_*_itinerance` country prefix.
- **Action taken:** 0013 keeps the swap **deliberately geography-agnostic** by design; non-French operator rows pass through if structurally valid.
- **Forward practice:** The swap layer ingests every row passing structural validity. Geographic scope is an API/UI concern, not a swap-layer one. If a future product decision says "drop non-French rows entirely," it gets its own migration with its own paper trail; do not retrofit the swap filter.

## E19 — IRVE precision mismatch (numeric(7,2) round-trip)

- **Surfaced:** T06b.1 (0013 first apply, SQLSTATE 23514).
- **What's wrong:** A staging row with `puissance_nominale = '0.0001'` rounds to `0.00` at `numeric(7,2)` (the destination column's type on `live.charge_points.power_kw`). The validity filter checked `> 0` BEFORE casting to destination precision, so the row passed the filter, then tripped the CHECK `power_kw > 0` constraint at insert time. Phase 1 audit missed type-precision round-tripping risk.
- **Action taken:** Migration 0014 corrects via `::numeric(7,2) > 0` cast inside the validity filter — checks against the post-cast value instead of the raw text.
- **Forward practice:** When defining or refactoring a validity filter in any swap function, list each destination column's full type signature (precision, scale, NOT NULL, CHECK constraints) at the top of the function comment. Run validity checks against the **post-cast** value when the destination has CHECK constraints sensitive to rounded values.

## E20 — IRVE PDC IDs not globally unique across stations (Phase 1 audit missed)

- **Surfaced:** T06b.1 (0014 first apply, station undercount caught by math-band guard).
- **What's wrong:** 13.0% of 155,830 distinct PDC IDs appear at multiple stations (max 3 per ID). Phase 1 §A.1 implicitly assumed global uniqueness. 0014 inherited 0013's `DISTINCT ON (id_pdc_itinerance)` at `valid_pdcs` level, which collapsed cross-station as well as within-station duplicates — silently dropped 7,289 stations on first apply.
- **Action taken:** Migration 0015 moves PDC-grain dedupe from `valid_pdcs` to inside `upsert_charge_points_from_staging` (target-table PK conflict site), leaving station-grain dedupe intact in `upsert_stations_from_staging`. `valid_pdcs` reverts to a pure validity filter.
- **Forward practice:** Before treating any external ID as a PK conflict target, run a cross-dimension uniqueness audit: `SELECT count(*), count(DISTINCT pk_candidate), count(DISTINCT pk_candidate || '|' || parent_dimension) FROM source`. If the third count exceeds the second, dedupe at the **target table's grain**, not at the validity-filter grain.

## E21 — Supabase free-tier database size limit triggered read-only protection

- **Surfaced:** T06b.3.a (workflow runs 25280453731 + 25280588232).
- **What's wrong:** Two consecutive `workflow_dispatch` runs with `force_refresh=true` hit `cannot execute <STATEMENT> in a read-only transaction` at varying statement sites (run #1 on `_upsert_meta`'s INSERT post-swap; run #2 on `close_ingestion_run`'s UPDATE inside the swap function itself). Initial diagnoses anchored on Supavisor pooler state leakage (incorrect) then free-tier compute quota auto-read-only (incorrect) before the dashboard Disk Size panel revealed the actual cause: free tier database limit of 500 MB exceeded (database 0.45 GB / ~90%, plus WAL 1.2 GB bloated from T06b.1's intensive 4-migration session, total disk 1.91 / 2 GB at 95.5%). Per Supabase free-tier behavior, projects enter read-only mode when the 500 MB database limit is exceeded. Recovery procedure (per [Supabase docs](https://supabase.com/docs/guides/platform/database-size#disabling-read-only-mode)): in dashboard SQL Editor, run `set session characteristics as transaction read write` to allow the session to issue writes, `truncate staging.irve_raw` to reclaim space (staging is ephemeral by design — see 0011 header), `vacuum` to reclaim physical pages, then `set default_transaction_read_only = 'off'` to disable the global protection. Post-recovery database size: 129 MB (well under the 500 MB ceiling).
- **Action taken:** None on the migrations or runner. Hard rule #4 atomicity held throughout: zero pollution to `live.stations` / `live.charge_points` despite the swap rolling back mid-function in workflow run 25280588232 when the read-only state caught the function mid-write — the run row was left dangling at `status='running'` and was closed manually via Supabase MCP at T06b.3 closing once the project exited read-only mode.
- **Forward practice:**
  - (a) `staging.irve_raw` must be truncated post-swap-success to keep steady-state database size well under the free-tier ceiling — current code truncates only at the start of the next run, which leaves staging populated for ~24h between runs. Consider modifying the runner to truncate immediately after swap success in a follow-up commit.
  - (b) **Read-the-instruments before symptom-matching** — query `SHOW default_transaction_read_only` AND check the dashboard's Disk Size panel before anchoring on connection-level hypotheses. This lesson cost ~2h of misdiagnosis across two incorrect narratives.
  - (c) Pro tier ($25/mo, 8 GB database included with spend cap ON) is the structural fix for M2+ when scrapers add concurrent write load — strongly recommended before T07 starts to avoid recurrence.
  - The CI verification of the swap path stands: workflow run 25280453731 confirmed the SQL function executes correctly in the GitHub Actions environment and the run row closes cleanly via the SQL contract; the retry confirmed the rollback contract (swap atomicity holds under mid-function read-only failure).

---

## Closing meta-note (T06b.1 → T06b.3, Phase 1 audit blind-spot pattern)

E17, E18, E19, E20 surfaced four distinct classes of Phase 1 audit blind-spot:

1. **Within-key duplicates** (E17) — sampling distinct values without measuring per-key cardinality.
2. **Prefix-distribution gaps** (E18) — postal-code-only geographic scoping without checking national-ID prefix distribution.
3. **Type-precision round-tripping** (E19) — checking validity against raw text without casting through the destination column's precision.
4. **Cross-dimension uniqueness** (E20) — assuming external PKs are globally unique without measuring `(id || parent)` cardinality vs `id`-alone cardinality.

Pattern: distinct-value sampling without per-key cardinality + cross-dimension cardinality + destination-type round-trip checks. Future ingestion-prep audits should run all three checks as standard. Paper trail, not a deliverable in this milestone.

---

## Discipline observations (T06b)

### Observation 1 — hard rule #4 atomicity caught four first-apply bugs across migrations 0012–0015 (T06b.1)

The single-txn-with-caller-controlled-rollback contract on `live.run_irve_swap` caught four Phase-1 blind spots in T06b.1 alone:

- 0012 first apply — SQLSTATE 21000 ON CONFLICT (E17) → ROLLBACK before any write.
- 0013 first apply — SQLSTATE 23514 CHECK violation (E19) → ROLLBACK before any write.
- 0014 first apply — station undercount (E20) caught by math-band guard before commit-to-git → no `live.*` state mutated.
- 0015 first apply — clean commit, three-call idempotence verified.

Without swap-in-a-txn discipline + math-band reconciliation, `live.*` would have been polluted with ~45k partial stations after 0014's first apply; recovery would have meant truncating prod or writing a reconciliation migration substantially uglier than 0015. Strict gating prevented real data damage four times in one session.

### Observation 2 — read-the-code-beats-trust-the-brief (T06b.2.a)

T06b.2.a discovered the SQL-side internal `close_ingestion_run` call by reading `0012_irve_swap_functions.sql:449` directly rather than trusting the brief's restatement. Not an erratum (the SQL is correct), but a discipline observation: the read-and-summarize-before-coding protocol caught a "ceremonial duplication" bug that would have shipped — the runner would have issued a redundant close on the success path, double-writing `finished_at` and contradicting the SQL design comment.

### Observation 3 — read-the-instruments-beats-symptom-matching (T06b.3.a)

Diagnosis of the read-only-transaction failures in workflow runs 25280453731 + 25280588232 anchored sequentially on three hypotheses: (1) Supavisor pooler state leakage (rejected after the retry produced a different statement-site failure), (2) Supabase free-tier compute quota auto-read-only (rejected after `pg_settings` showed `source = configuration file` not a platform-level flip), (3) **disk-full / database-size-ceiling read-only protection** (correct, identified via the dashboard Disk Size panel — free-tier 500 MB database limit reached). Each hypothesis was plausible from connection-level symptoms; the dashboard's Disk Size panel would have surfaced the answer in seconds had it been checked first. Cost: ~2h misdiagnosis.

Lesson: when Postgres connection-level errors are unusual, **query the cluster's actual state and check the platform's resource panels before anchoring on connection-level hypotheses**. Instruments beat symptoms.

Hard rule #4 atomicity held throughout: zero pollution to `live.stations` / `live.charge_points` despite the swap rolling back mid-function under the actual environmental failure mode — the contract protected against a failure class we did not know to design against, which strengthens not weakens its value. The fifth catch by hard rule #4, this time under database-size-ceiling read-only.

---

## Adding new entries

1. Append below the last entry, numbered `E<n+1>`.
2. Include the surfacing session, the precise issue, action taken (usually "none"), and the forward practice for new migrations.
3. Commit with `docs: migrations-errata add E<n>` (or batch as `docs: migrations-errata staging <session> findings`).
4. Append-only — never edit existing entries except for typo fixes.

---

## E22 — IRVE PDC-grain cardinality doesn't predict station-grain at API normalization grain (Phase 1 audit blind-spot, 5th instance)

- **Surfaced:** T07.1 (BAN reverse-geocode acceptance bar derivation); compounded at T08.0 (operator-resolver forecast).
- **What's wrong:** Phase 1 §A.1 sampled IRVE at PDC grain (224,467 rows). T06b's swap dedupes to 52,806 stations via `DISTINCT ON (id_station_itinerance)` per E20. T07.1's acceptance bar derived "expect ≥21,097 successful geocodes" using a heuristic anchored on PDC-grain ratios; the actual station-grain work-set was 21,737 stations needing geocoding (~1.39 dedupe factor between PDC-grain and station-grain). T08.0's forecast (28,789) similarly drifted from measured (29,446) when the per-enseigne distribution underlying the forecast came from a Phase-1 PDC-grain snapshot but the resolver operates at station-grain post-dedupe. Per-operator divergences are stark: Power Dot 13,896 → 1,142, Freshmile 9,274 → 3,110, etc.
- **Action taken:** None on the migrations or runner. T07.3 closing summary documented the divergence as a forecast-vs-measured discrepancy rather than a defect; T08.1 locked the acceptance bar against the measured value (29,446) rather than the Phase-1-derived forecast.
- **Forward practice (T07-era):** Acceptance bars derived from Phase 1 distribution numbers MUST be re-grounded against current live state via `SELECT` before being treated as load-bearing. Any number citing "expect N rows" should also state the grain at which N was measured (PDC-grain, station-grain, post-dedupe-at-target, etc.).
- **Application notes (W4):** Plan filename drift continues — `docs/03-implementation-plan.md §T08` referenced `0012_operator_aliases.sql`; actual landed at `0016_operator_aliases.sql` (E14 numbering pattern; the chain had advanced to 0015 by W4 start). Forward-practice expansion: when describing a seed migration's row count, count VALUES rows programmatically before pasting any "N operators / N aliases" claim. T08.0 design summary said "33 operators" while the actual seed had 34 — eyeball-counting fails on lists of this size. Concrete recipe: `awk` or `grep -c` against the VALUES block of the staged migration immediately before drafting any prose count.

## E23 — IRVE long-tail enseigne pattern: 23,360 stations (44.2%) lack a curated alias mapping; 91% of the gap is heterogeneous miscellaneous, not prefix-pattern operators (Phase 1 audit blind-spot, 6th instance)

- **Surfaced:** T08.2 closing (long-tail audit query post-resolve).
- **What's wrong:** T08's curated seed covers 29,446 of 52,806 stations (55.8%). The 23,360-station NULL bucket decomposes as: 1,658 Allego site-suffix variants (`'allego - <site>'`), 249 Réseau-de-recharge variants (~70 small public-tender CPOs each <30 stations), 60 Fastned site-suffix (`'fastned <site>'`), 52 TotalEnergies site-suffix (`'totalenergies - <site>'`), and **21,341 miscellaneous (91% of the gap)**. Phase 1 §A.1's distribution implied prefix-pattern operators would dominate the long tail; reality is genuinely heterogeneous low-volume operators (likely individual public-tender CPOs and private installations).
- **Action taken:** None on the migrations or runner. T08's hard rules accepted the long-tail NULL state by design (T08.0 Q4). Concrete numbers locked into closing summary for M1.5 prioritization input.
- **Forward practice:** M1.5+ prefix-rule alias type (`confidence='prefix'` with LIKE-based matching) recovers at most ~2,019 stations (Allego + TotalEnergies + Fastned prefixes — 91% of those identifiable patterns sit in just the Allego prefix family, 1,658 / 1,770). The remaining ~21,341 requires either broader curated seed, programmatic operator extraction from `nom_amenageur` / `id_station_itinerance` prefixes, or accepting a permanent ~40% NULL operator floor for M1. **Decide M1.5 prioritization based on these concrete volumes**, not the Phase-1 estimate that overweighted prefix patterns. Reframes E23 from "M1.5 prefix-rule recovers most of the gap" to "M1.5 prefix-rule recovers ~9% of the NULL bucket; the remaining 91% needs a different strategy entirely."

---

## Closing meta-note (W4 close — Phase 1 audit blind-spot pattern refresh)

Supersedes the T06b.1 → T06b.3 closing meta-note in scope, but the original entry stays as historical record per append-only convention.

Phase-1 A.1 audit method missed **six classes of issue across W3+W4**:

1. **Within-key duplicates** (E17) — sampling distinct values without measuring per-key cardinality.
2. **Prefix-distribution gaps** (E18) — postal-code-only geographic scoping without checking national-ID prefix distribution.
3. **Type-precision round-tripping** (E19) — checking validity against raw text without casting through the destination column's precision.
4. **Cross-dimension uniqueness** (E20) — assuming external PKs are globally unique without measuring `(id || parent)` cardinality vs `id`-alone cardinality.
5. **Cardinality at API-normalization grain** (E22) — PDC-grain Phase-1 numbers don't predict post-dedupe station-grain reality at API call sites or alias resolvers (1.39× factor in practice).
6. **Long-tail composition** (E23) — distribution-by-top-N skews the operator's mental model; the long tail's *internal* composition (prefix-pattern vs heterogeneous miscellaneous) matters as much as its size, and Phase 1 didn't measure it.

**Pattern (refreshed v2):** distinct-value sampling without per-key cardinality + cross-dimension cardinality + destination-type round-trip checks + post-transformation grain re-grounding + long-tail composition analysis. Future ingestion-prep audits should run all five checks as standard. Bundle these as the **"Phase 1 audit checklist v2"** if M2 introduces a new dataset or M1.5 expands the alias seed.

### Hard rule #4 cumulative tally (W3+W4 close)

Hard rule #4 atomicity has now caught **8+ issues across W3+W4**:

- T06b.1 — 4 first-apply bugs in 0012, 0013, 0014, 0015 (E17, E19, E20, idempotence verification respectively).
- T06b.3.a — 1 environmental fault (cluster-level read-only flip mid-swap, E21).
- T07.3 — 2 runner bugs (chunked-commit dedupe error + skip-caching infinite-loop).
- T08.1 — 1 self-count drift caught pre-commit by COMMENT review (33 vs 34 operators).
- T08.2 — surfaced forecast-vs-measured drift (28,789 vs 29,446) which the locked-bar pattern absorbed without runtime impact.

The contract is load-bearing infrastructure for this codebase's correctness story. Strict gating prevented real data damage at every catch site.

---

## Discipline observations (W4 additions)

### Observation 4 — skip-caching-on-failure creates termination bugs in iterative pipelines (T07.1)

T07.1's design call (d) prescribed *"skip caching not-found rows"* for the BAN reverse-geocode runner. Intent: preserve the option of recovering when BAN coverage improves. Unintended consequence: the work-set query used `NOT EXISTS (SELECT 1 FROM live.geocode_cache WHERE …)` to bound each chunk; not-found rows would NOT be cached, so the work-set never converged for stations BAN couldn't resolve. The runner went into an infinite loop on the second chunk, processing the same not-found stations repeatedly until manually killed (run `d3dbff58`, ~15 min runaway).

Fix: negative-cache pattern with 30-day TTL — `score=0` entries that satisfy `NOT EXISTS` without satisfying the apply gate (≥0.5). Hard rule #4 atomicity preserved committed work; chunk-grain rollback meant zero state damage.

**Forward practice:** when a work-set query is bounded by a `NOT EXISTS` predicate against a cache, **every queried input must produce a cache row regardless of outcome** (positive or negative-cache), or the loop will not terminate for failure cases. Skip-caching is appropriate only for one-shot idempotent runners that rebuild the cache from scratch, not for iterative chunked runners.

### Observation 5 — Phase-1 audit numbers stop being load-bearing after T06b's PDC dedupe (W4-wide)

Phase 1 §A.1 sampled the 224,467-row IRVE consolidated CSV; T06b's swap dedupes to 52,806 distinct stations via `DISTINCT ON (id_pdc_itinerance)` at PDC grain plus `DISTINCT ON (id_station_itinerance)` at station grain (E20). Per-operator distributions diverge sharply post-dedupe: Power Dot 13,896 → 1,142, Freshmile 9,274 → 3,110, QPARK 3,612 → 1,945, etc. T07.3's acceptance bar derived "≥21,097 successful geocodes" assuming 1:1 station-to-coord ratio (E22); reality was 1.39 dedupe factor. T08.0's "expected coverage" forecasts (28,789) drifted from measured (29,446) for the same reason.

**Forward practice:** for any task that cites Phase-1 numbers as a baseline, **re-ground against current live state via `SELECT` before accepting the number as load-bearing**. Phase 1's value is qualitative (the existence of LIDL→Power Dot relationships, the structural shape of the dataset) — not quantitative (specific row counts post any T06+ transformation). The audit-blind-spot pattern (E17/E18/E19/E20/E22/E23) consistently traces to "sampled at the wrong grain" or "didn't measure cardinality at the relevant target grain." Future audits should cite both the source-grain count AND the post-transformation grain it predicts.

---

## Notes (paper trail, W4)

### Source-row pattern divergence (T07 vs T08)

T07's `live.sources` row for `ban_reverse_geocode` was inserted at runner startup via in-runner `INSERT ... ON CONFLICT (slug) DO NOTHING` (`tools/geocode/main.py:_ensure_ban_source_row`). T08's row for `operator_resolver` was inserted in migration `0016_operator_aliases.sql`. Both patterns work; both ship in M1.

Migration-side is structurally cleaner (immutable, version-controlled, idempotent on re-apply, no startup cost, lint-gated by libpg_query/sqlfluff before merge). T07's runtime pattern was a deliberate choice at the time to avoid creating a migration just for the source row. T08's migration-side approach was natural because 0016 already carried operator/alias seed.

**Not an erratum.** Documented for M2 housekeeping consolidation when a standardization decision becomes worth the churn.

---

## E22 — application notes (W5 expansion)

After E22's original W4 entry, three W5 sites added concrete data:

- **T13.0 design summary** said "33 operators" while the seed had 34 (caught pre-commit by COMMENT review — hard rule #4 catch #8 in W4).
- **T11 design summary** forecast 28,789 station coverage; measured 29,446 — same pattern as the T08 self-count drift (locked-bar pattern absorbed via post-flight verification).
- **T12 design summary** forecast 32 decimal-cts rejections; measured 21 — post-flight baseline correction; smoke gate anchored to the verified value, not the forecast.

The eyeball-vs-programmatic-counting discrepancy now has 5+ instances across W4+W5. **Forward-practice expansion:** any "N operators / N aliases / N rows" claim in design summaries must be cross-verified by SQL count or programmatic VALUES line-count before locking acceptance bars. Pattern is structural, not incidental.

---

## E24 — `live.stations.consolidated_code_postal` lacks an index post-T07; single-query CTE form Seq Scans 52,806 rows = 2,022 ms (T15.1 viewer)

- **Surfaced:** T15.1 pre-flight (Wasquehal demo query probe via Supabase MCP).
- **What's wrong:** The "natural" single-query shape for the search anchor — `WITH center AS (SELECT AVG(ST_X(geom::geometry)) ... WHERE consolidated_code_postal = $1) SELECT ... FROM stations CROSS JOIN center ORDER BY geom <-> center LIMIT 10` — forces a Seq Scan over all 52,806 rows because the AVG aggregate materializes the entire postal-filter set before the KNN can stream. Measured 2,022 ms (over the 2 s M1 viewer budget).
- **Action taken:** None on schema or migrations. T15.1's `searchStationsByPostal` uses a two-query workaround: (a) `LIMIT 1` postal-anchor lookup ≈ 30 ms (early-stop seq scan, only one row needed), then (b) KNN with literal `lng`, `lat` coordinates ≈ 150 ms. Total ≈ 180 ms server-side. Hard rule W5 #8 ("no new indexes for M1") preserved. Documented in the queries.ts top comment so the maintainer who eventually adds the index can collapse to one query.
- **Empirical wall-clock (T15.2 smoke):** `/internal/search?q=59290` = 782 ms cold including postgres-js pool init; subsequent calls ≈ 180 ms. Well under the 2 s budget.
- **Forward practice:** add a btree index on `consolidated_code_postal` in M1.5 once viewer search patterns stabilize, then refactor to the single-query CTE form. The single-row early-stop already works fine; the index unlocks the AVG-aggregate-friendly form for any future feature that needs the postal-set centroid (radius queries, postal heatmaps).

---

## Audit-blind-spot pattern, instances #7–#10 (W5)

- **#7 (T10 pre-flight, DRIVECO JSON):** Phase 1 §D.1 reported "5 distinct DRIVECO schemas." Reality: 1 top-level shape signature with 5 distinct value-tuples in `energyPrice`. **Forward-practice:** distinguish "shape" (top-level key signature, structural type) from "value distribution" (numeric/string variants within a fixed shape).
- **#8 (T11 pre-flight, CITEOS):** Phase 1 §D.1 + §D.2 framed as 8,656 rows / ~65 distinct values / "CPO CITEOS" enseigne family. Reality: 12,020 rows (+39%), 131 distinct values (~2×), 11 enseignes (CITEOS variants + eborn 3,443 + Easy Charge Services 1,306 + AVIA VOLT 117), `default_start_fee` ("prix de départ") clause type 226 occurrences missed entirely. **Forward-practice:** when a template hallmark is detected, count enseigne distribution before scoping the parser; do not assume operator-template 1:1 correspondence.
- **#9 (T12 pre-flight, regex €/kWh):** Phase 1 §D.1 framed `PRICE_KWH_NL` ~ 8,351 rows €/kWh family. Pre-flight surfaced a parallel `cts/kWh` family of 3,265 rows missed entirely (3,233 integer-centimes + 32 decimal-cts ambiguity). Net hallmark volume +40%. The cts family includes major operators: Carrefour Energies 1,573, ALLEGO 1,173 — not just the EVBOX outlier Phase 1 named. **Forward-practice:** when surveying free-text price patterns, enumerate ALL unit symbols (€, cts, ct, EUR, euro, cents) per family before scoping the parser.
- **#10 (T13.0 pre-flight, station-grain tarification conflict):** 3,052 of 14,151 content-bearing stations (21.6%) have ≥ 2 distinct `tarification` values across their PDCs. Real examples: `FR3R3P89882136` carries '0,36 €/kWh' AND '0,55 €/kWh' (likely AC vs DC connectors); `FRA68P68021001` carries '15' AND '0,40' (FLAT vs per-kWh). PDC-grain Phase-1 numbers do not predict station-grain reality. **Forward-practice:** when copying staging→live across grain boundaries, `DISTINCT ON` the target grain with explicit `ORDER BY` priority field. Same pattern as E20.

**Cumulative pattern (10 instances E17/E18/E19/E20/E22/E23 + #7/#8/#9/#10):** Phase 1 audit method has consistent failure modes — distinct-value sampling without per-key cardinality + cross-dimension cardinality + destination-type round-trip + post-transformation grain re-grounding + long-tail composition + shape-vs-value-distribution + multi-operator-scope assumption + unit-symbol enumeration + cross-grain conflict assumption. Bundle as **"Phase 1 audit checklist v2"** if M2 introduces a new dataset.

---

## E21 — instances #2 + #3 (Supabase free-tier disk-full recurrence + Pro-tier-disk gotcha)

After E21's original W3 entry (cluster-level read-only flip), W5 added two further instances of disk-pressure failures along the same staging→live swap path:

- **E21 instance #2 (W5, T13.2 first attempt):** Pre-T13.2 IRVE sync hit `FileFallocate` disk-full at the `CREATE TEMP TABLE valid_pdcs` step. DB went from 134 MB → 452 MB (90.4% of 500 MB free-tier ceiling) before failure. Hard rule #4 atomicity held: the swap rolled back, zero `live.*` pollution. Recovery via `TRUNCATE staging.irve_raw` + `VACUUM` → back to 134 MB baseline.
- **E21 instance #3 (W5, T13.2 second attempt post-Pro-tier-upgrade):** **Pro tier upgrade DID NOT prevent recurrence.** Same `FileFallocate` failure mode, same temp-table allocation step. Pro tier raises the database-size logical ceiling 500 MB → 8 GB, but the underlying disk volume must be auto-resized OR manually grown OR project-restarted for the new allocation to take effect. `pg_database_size()` reports table/index data only; doesn't count WAL or temp space backed by the physical disk volume.

**Forward-practice expansion (E21 (c) update):** "Pro tier upgrade alone may not raise the underlying disk volume on Supabase managed instances. Verify Disk Size in Settings → Billing → Usage post-upgrade, and confirm successful sync before declaring disk pressure resolved. Operator may choose workaround paths that bypass staging entirely if Pro upgrade is rejected on cost grounds."

**Operator decision (W5):** Path B workaround (T13.0.5 local cache loader) chosen over Pro tier. M1 ships on free tier with documented removal triggers (next entry).

---

## T13.0.5 — M1 workaround framing (W5)

`tools/load-tarification-from-cache/main.py` loads `live.stations.tarification` directly from `.cache/irve.csv` via 5,000-row chunked UPDATEs, bypassing the `staging.irve_raw` swap pipeline that hits E21 disk-full failures on free-tier Postgres. Uses the same canonical-row strategy as `live.copy_tarification_from_staging()` (`DISTINCT ON id_station_itinerance ORDER BY date_maj DESC NULLS LAST`) for behavioral parity. **Net DB delta:** ~7 MB (vs +318 MB for the swap path).

**M1.5 removal triggers** (any one):

- Supabase Pro tier disk allocation verified at 8 GB AND `tools/irve-sync` succeeds without `FileFallocate` (E21 forward-practice update verified).
- Chunked-swap refactor of `run_irve_swap` landed.
- Migration to a non-free-tier hosted Postgres.

Until then, this loader is the sole writer of `live.stations.tarification`. Operator triggers it manually before each parser orchestrator run. `live.copy_tarification_from_staging()` and the irve-sync swap-path call to it remain in place dormant — pure file-delete cleanup when removal triggers fire.

---

## Hard rule #4 cumulative tally (W5 close)

Hard rule #4 atomicity has now caught **13+ issues across W3+W4+W5**:

**W3 + W4 (8):**

- T06b.1 — 4 first-apply bugs in 0012/0013/0014/0015 (E17, E19, E20, idempotence verification respectively).
- T06b.3.a — 1 environmental fault (cluster-level read-only flip mid-swap, E21).
- T07.3 — 2 runner bugs (chunked-commit dedupe error + skip-caching infinite-loop).
- T08.1 — 1 self-count drift caught pre-commit by COMMENT review (33 vs 34 operators).

**W5 (5+):**

- T13.2 pre-tx FK check caught a missing payment_method slug (catch #9 — 0 writes).
- T13.2 Postgres `MAX_PARAMETERS_EXCEEDED` tx rolled back (catch #10).
- T13.2 `parser_outcomes_dedupe_unique` constraint within-run rolled back (catch #11).
- T13.2 SUCCESS atomic commit (catch #12, success-path validation).
- E21 instances #2 and #3 disk-full atomic rollback — 2 instances (catch #13).

**The contract continues to be load-bearing infrastructure for this codebase's correctness story.** 13+ catches across 5 weekend sessions, zero data damage incidents.

---

## Discipline observations (W5 additions)

### Observation 6 — surface-vs-substance pattern survives a fourth weekend (T13.0 + T13.2)

T13.0's brief framed migration 0018 as a "trivial column add" (~5 LOC). Reality after pre-flight: a column add + a SQL function (`live.copy_tarification_from_staging`) implementing canonical-row selection (DISTINCT ON id_station_itinerance ORDER BY date_maj DESC NULLS LAST) for the 21.6% station-grain conflict case + an irve-sync amendment to call the function post-swap + idempotency guarantees. Substance was 70 LOC of SQL across 0018 + 60 LOC of Python amendment.

T13.2's brief framed parser_outcomes writing as "one row per parser hit." Reality: schema-level UNIQUE (raw_input_hash, source_id, parser_version) by design (0007 D5) means **input-grain dedupe must happen orchestrator-side BEFORE INSERT** — collapsing 14,111 station-grain hits to 422 unique input-grain rows. Brief didn't surface this; pre-flight mapping the schema constraint to the writer's responsibility did.

**Forward-practice (paired with discipline obs #1, #3):** every brief estimate gets two verifications — (a) read the schema constraints that bind the writer, (b) pre-flight a synthetic shape against those constraints — before locking complexity. The sub-trivial-looking task is the most likely to hide structural surprise.

### Observation 7 — Read-the-current-docs beats trust-the-brief (T15.1 + T15.2)

Brief filename was `middleware.ts`; Next 16 renamed to `proxy.ts` with function name `proxy()` (per `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`). Brief assumed Tailwind utility `grid-cols-24`; Tailwind v4 ships only `grid-cols-1..12` by default. Brief assumed synchronous `params`/`searchParams`; Next 16 made them Promises (15.0.0-RC change documented in `page.md`).

All three caught at T15.1/T15.2 implementation time by reading current installed-version docs before writing code. **Forward-practice:** any time the brief assumes a framework convention, verify against current installed-version docs (`node_modules/<framework>/dist/docs/`, official site, or release notes for major-version bumps). The cost of one doc read is dwarfed by the cost of debugging a build break post-commit.

**Pairs with discipline obs #2** (read-the-code-beats-trust-the-brief) — same pattern at the dependency-version layer rather than the codebase layer. AGENTS.md's "this is NOT the Next.js you know — read the relevant guide first" rule is the explicit codification of this discipline.

---

## Closing meta-note (W5 close — Phase 1 audit blind-spot pattern refresh v3)

Supersedes the W4 closing meta-note in scope; the W4 entry stays as historical record per append-only convention.

Phase-1 A.1 audit method now has **10 documented failure-mode instances across W3 + W4 + W5**:

1. **Within-key duplicates** (E17) — sampling distinct values without measuring per-key cardinality.
2. **Prefix-distribution gaps** (E18) — postal-code-only geographic scoping without checking national-ID prefix distribution.
3. **Type-precision round-tripping** (E19) — checking validity against raw text without casting through the destination column's precision.
4. **Cross-dimension uniqueness** (E20) — assuming external PKs are globally unique without measuring `(id || parent)` cardinality vs `id`-alone cardinality.
5. **Cardinality at API-normalization grain** (E22) — PDC-grain Phase-1 numbers don't predict post-dedupe station-grain reality at API call sites or alias resolvers (1.39× factor in practice).
6. **Long-tail composition** (E23) — distribution-by-top-N skews the operator's mental model; the long tail's *internal* composition matters as much as its size.
7. **Shape vs value-distribution conflation** (#7, T10) — "5 distinct schemas" reported when reality was 1 shape × 5 value tuples.
8. **Multi-operator-scope assumption** (#8, T11) — assuming an operator-template hallmark maps 1:1 to one operator family; reality was 11 enseignes sharing the CITEOS template.
9. **Unit-symbol enumeration gap** (#9, T12) — surveying free-text prices by one unit symbol misses parallel families under different symbols (€/kWh missed cts/kWh's 3,265-row family).
10. **Cross-grain conflict assumption** (#10, T13.0) — copying across grain boundaries without `DISTINCT ON` the target grain when source-grain rows can disagree on column values.

**Pattern (refreshed v3):** distinct-value sampling without per-key cardinality + cross-dimension cardinality + destination-type round-trip + post-transformation grain re-grounding + long-tail composition + shape-vs-value-distribution + multi-operator-scope assumption + unit-symbol enumeration + cross-grain conflict. **Bundle these as the "Phase 1 audit checklist v2"** if M2 introduces a new dataset or M1.5 expands the alias seed.

