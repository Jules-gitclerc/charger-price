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

---

## Adding new entries

1. Append below the last entry, numbered `E<n+1>`.
2. Include the surfacing session, the precise issue, action taken (usually "none"), and the forward practice for new migrations.
3. Commit with `docs: migrations-errata add E<n>` (or batch as `docs: migrations-errata staging <session> findings`).
4. Append-only — never edit existing entries except for typo fixes.
