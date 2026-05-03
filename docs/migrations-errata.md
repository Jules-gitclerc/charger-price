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
