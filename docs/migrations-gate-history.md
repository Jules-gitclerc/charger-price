# Migrations gate-run history

Append-only ledger of libpg_query (parse-only) gate runs against the
migrations corpus. The pre-commit hook (`scripts/lint/libpg-query.cjs`,
landed in commit `4a762b9`) applies the gate to staged files on commit;
this file captures retroactive batch runs against the historical corpus.

Append a new section when:

- A retroactive run is performed for any reason (corpus growth, gate
  version bump, audit prep, post-mortem investigation).
- The gate's parser version (libpg_query / pg-query-emscripten) is
  upgraded — re-run against the full corpus to verify no parse-shape
  regressions.
- Pre-major-milestone audits (e.g. M2 launch readiness).

Do not append for routine pre-commit gate hits — those are captured in
commit history via the hook itself.

Append a new section below the last; never edit existing entries except
for typo fixes.

---

## 2026-05-03 — T07.0 retroactive run on 0001-0015

- **Scope:** all migrations that landed in W2 + W3 (T04 → T06b.1).
- **Reason:** the gate landed mid-W3 (commit `4a762b9`); migrations
  0001-0010 were authored before the gate existed. Verifying
  retroactively to close the W3 → W4 transition.
- **Command:** `for f in supabase/migrations/*.sql; do node scripts/lint/libpg-query.cjs "$f"; done`
- **Result:** 15/15 parse clean.

```
0001_extensions.sql: parse OK
0002_identity.sql: parse OK
0003_payment_methods.sql: parse OK
0004_tariffs.sql: parse OK
0005_provenance.sql: parse OK
0006_tariff_history.sql: parse OK
0007_ingestion_audit.sql: parse OK
0008_geocode_corrections.sql: parse OK
0009_community_reports.sql: parse OK
0010_bulk_read_indexes.sql: parse OK
0011_staging_irve_raw.sql: parse OK
0012_irve_swap_functions.sql: parse OK
0013_irve_swap_filter_dedupe.sql: parse OK
0014_irve_swap_power_precision.sql: parse OK
0015_irve_swap_pdc_dedupe_at_target_grain.sql: parse OK
```

---

## 2026-05-04 — W5 closing run on 0016–0018

- **Scope:** migrations that landed during W4 closing + W5 (T08.1 → T13.0).
- **Reason:** W5 closing-bundle hygiene; verifying the corpus added since the
  T07.0 retroactive run completes the gate-clean baseline through T13.
- **Command:** `for f in supabase/migrations/0016_*.sql supabase/migrations/0017_*.sql supabase/migrations/0018_*.sql; do node scripts/lint/libpg-query.cjs "$f"; done`
- **Result:** 3/3 parse clean.

```
0016_operator_aliases.sql: parse OK
0017_doc_comments.sql: parse OK
0018_stations_tarification.sql: parse OK
```

### 0018 — T13.0 application notes

`chore(T13.0): migration 0018 + irve-sync amendment for §0 gap (Option C)` (commit `add8f15`).

- **libpg_query parse:** clean.
- **sqlfluff lint:** clean.
- **Apply-time:** ~50 ms (column-add to a 52,806-row table; no data rewrite, just metadata).
- **Idempotency re-apply:** clean (`ADD COLUMN IF NOT EXISTS` + `CREATE OR REPLACE FUNCTION`).
- **Synthetic round-trip:** 2 rows updated correctly via the canonical-row strategy (`DISTINCT ON id_station_itinerance ORDER BY date_maj DESC NULLS LAST`); 0 affected on second call (idempotent).

In production the function is dormant — the irve-sync swap path is the canonical caller, but the M1 workaround `tools/load-tarification-from-cache/main.py` (T13.0.5) writes `live.stations.tarification` directly from `.cache/irve.csv` to bypass E21 disk pressure on free-tier Postgres. See `migrations-errata.md` "T13.0.5 — M1 workaround framing" for removal triggers.
