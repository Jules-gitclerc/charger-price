-- Migration 0010 — Bulk read-path indexes (final T05 migration)
--
-- T05, M1 W2.
--
-- WHY HAND-ROLLED SQL (not Drizzle-Kit generated):
--   Partial indexes with WHERE clauses + DESC ordering specifications
--   are more naturally expressed in raw SQL than via a Drizzle migration
--   generator. No table changes here, only index creation.
--
-- IDEMPOTENCY: every CREATE INDEX uses IF NOT EXISTS.
--
-- COST WARNING:
--   If applying against a populated DB, this migration may take minutes
--   per index (the IRVE-loaded M2 case). Against the empty M1 DB it is
--   instant. Either way, no destructive ops — no DROP INDEX, no ALTER,
--   no UPDATE. Worst case is a brief lock during index build on a busy
--   table; we accept that for M1.
--
--   For populated-DB re-indexing in M2+ if locks become an issue: run
--   `CREATE INDEX CONCURRENTLY` out-of-band, NOT as a migration.
--   CONCURRENTLY cannot run inside a transaction, which Supabase's
--   migration runner wraps every migration in. See the future
--   docs/operations/index-rebuild.md runbook (M2 deliverable).
--
-- INDEX OVERLAPS WITH PRIOR MIGRATIONS — single-source-of-truth pattern:
--   The T05 brief originally specified some indexes here; per the
--   pattern established in 0007/0008/0009, indexes live in the
--   migration that creates the table they index. 0010 documents the
--   resolved overlaps so a future reader searching for "where is the
--   X index" finds the answer here even if they started here:
--
--     - parser_outcomes (raw_input_hash)
--         → lives in 0007 as parser_outcomes_hash_idx
--     - corrections (submitted_at DESC) WHERE status='pending'
--         → lives in 0008 as corrections_pending_queue_idx
--     - community_reports (reported_at DESC) WHERE status='pending'
--         → lives in 0009 as community_reports_pending_queue_idx
--     - tariff_history (station_tariff_id, snapshot_at DESC)
--         → lives in 0006 as tariff_history_station_tariff_idx
--           [4th overlap, not in the original T05 brief — caught
--            during 0010 review and documented here]
--
-- DESIGN CALLS (per T05 brief §0010 review):
--
-- D1 — Architecture-driven additional indexes:
--   Reviewed docs/02-architecture.md §2 (system architecture) and §3
--   (tech stack) for read-path queries. Findings:
--
--     a) stations (consolidated_code_postal) — NOT added. Address
--        search is geo-driven (BAN autocomplete → ST_DWithin), already
--        covered by stations_geom_gist (0002). Postal-code-only listing
--        is not a primary read path in §4.2.
--
--     b) stations (consolidated_commune) — NOT added. Same rationale.
--
--     c) station_tariffs (confidence) WHERE valid_to IS NULL — NOT
--        added. The coverage_summary query
--        (`/qualite-des-donnees`, M1.5 W11) reads
--        confidence counts on the active set. Existing
--        station_tariffs_active_idx + station_tariffs_confidence_idx
--        together cover this; Postgres can intersect them. A composite
--        partial would be marginal at M1 row counts.
--
--     d) ingestion_runs (source_id, started_at DESC) — ADDED. The
--        admin freshness dashboard (`/admin/sources` per §2.7) queries
--        "recent runs by this scraper": SELECT * FROM ingestion_runs
--        WHERE source_id=$1 ORDER BY started_at DESC LIMIT N. No
--        existing index supports this; row count grows linearly with
--        runs (~daily IRVE + weekly scrapers ⇒ ~10 rows/day in M1).
--
-- D2 — Plain CREATE INDEX IF NOT EXISTS:
--   Option (a) per T05 brief review. Idempotent, simple. Populated-DB
--   re-indexing is an M2+ operations concern; out-of-band CONCURRENTLY
--   if needed.
--
-- D3 — Index naming convention:
--   Following the established <table>_<purpose>_idx pattern. New
--   indexes:
--     - station_tariffs_payment_active_idx (purpose=active subset,
--       primary col=payment_method_id; mirrors the 0005
--       station_tariffs_active_idx naming)
--     - ingestion_runs_source_recent_idx (purpose=recent runs by source)
--
--   Naming inconsistency observed across 0001-0009 worth flagging
--   (deferred to docs/migrations-errata.md per T04 closing): some
--   indexes use `_<col>_idx` (e.g. `stations_geom_gist` — not even
--   _idx), others use `_<purpose>_idx` (e.g. `corrections_pending_
--   queue_idx`). No action in 0010 — append-only history binds.

-- ─────────────────────────────────────────────────────────────────────────
-- Index 1: reverse-lookup partial composite on station_tariffs.
-- Query shape: "all stations supporting this payment method"
--   SELECT station_id FROM live.station_tariffs
--    WHERE payment_method_id = $1 AND valid_to IS NULL;
-- The existing station_tariffs_active_idx (station_id, payment_method_id)
-- can answer this but requires an index scan; this reversed-column
-- partial composite makes the lookup an index-only scan.
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS station_tariffs_payment_active_idx
  ON live.station_tariffs (payment_method_id, station_id)
  WHERE valid_to IS NULL;

COMMENT ON INDEX live.station_tariffs_payment_active_idx IS
  'Reverse-lookup partial composite. "Which stations support payment method X?" hot path. WHERE valid_to IS NULL — active rows only.';

-- ─────────────────────────────────────────────────────────────────────────
-- Index 2: ingestion_runs admin query.
-- Query shape: "recent runs of this scraper"
--   SELECT * FROM live.ingestion_runs
--    WHERE source_id = $1 ORDER BY started_at DESC LIMIT N;
-- Powers /admin/sources freshness dashboard (architecture §2.7).
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS ingestion_runs_source_recent_idx
  ON live.ingestion_runs (source_id, started_at DESC);

COMMENT ON INDEX live.ingestion_runs_source_recent_idx IS
  'Admin freshness dashboard hot path: recent runs per source ordered newest-first.';
