-- Migration 0007 — ingestion_runs + parser_outcomes
--
-- T05, M1 W2.
--
-- WHY HAND-ROLLED SQL (not Drizzle-Kit generated):
--   Multi-column CHECK constraints encoding the ingestion_runs state
--   machine (running ⇔ finished_at NULL), enum CHECKs, raw_input length
--   bound, the sha256 hex format CHECK, and the dedupe UNIQUE
--   (raw_input_hash, source_id, parser_version) are all clearer in raw
--   SQL. Reuses live.set_updated_at() from 0002 for ingestion_runs.
--
-- IDEMPOTENCY: every CREATE uses IF NOT EXISTS. Triggers use DROP IF
-- EXISTS + CREATE.
--
-- ENTITIES (per docs/02-architecture.md §1.2 + T05 brief):
--   ingestion_runs   — one row per scheduled job execution. Powers the
--                      freshness dashboard and the "did the daily IRVE
--                      sync run?" alerting. State machine: 'running' →
--                      ('success' | 'failed' | 'partial').
--   parser_outcomes  — one row per IRVE row processed (or scraper item
--                      ingested). Append-only audit log enabling parser
--                      regression replay without re-downloading the
--                      150 MB IRVE CSV. Dedupe via UNIQUE
--                      (raw_input_hash, source_id, parser_version).
--
-- DESIGN CALLS (per T05 brief §0007 review):
--
-- D1 — finished_at state machine: enforced via CHECK.
--   - status='running'  ⇔ finished_at IS NULL
--   - status terminal   ⇔ finished_at IS NOT NULL
--   - finished_at >= started_at when both set
--   The application transitions a row from 'running' → terminal in a
--   single UPDATE that sets both status and finished_at. The CHECK
--   prevents half-transitions.
--
-- D2 — 'partial' status semantics:
--   The run completed end-to-end (no fatal abort) but produced either
--   rows_skipped > 0 OR error_message IS NOT NULL. Use 'partial' instead
--   of 'success' when the operator should investigate but the data is
--   still useful. Use 'failed' only when the run aborted before
--   producing any usable output. NOT enforced by CHECK — too brittle
--   (a clean run with rows_skipped=0 default could trip it). Application
--   discipline.
--
-- D3 — raw_input length CHECK at 64 KB:
--   IRVE tarification values are typically <500 chars; DRIVECO JSON
--   dumps reach ~2 KB; edge cases up to ~10 KB observed in Phase 1.
--   65536 is comfortably above any real value but rejects truly absurd
--   payloads (e.g. a scraper accidentally dumping a full HTML page) at
--   write time. Cheap defense.
--
-- D4 — parsed_value_json shape:
--   Free jsonb, no schema validation at DB level. Application code
--   (parser pipeline, T13) is responsible for shape. Documented in
--   column COMMENT. Future Zod schemas could be checked at API
--   boundary if needed.
--
-- D5 — Index overlap with 0010:
--   parser_outcomes (raw_input_hash) lives HERE in 0007 (single source
--   of truth), NOT in 0010. The T05 brief mentioned it in both places;
--   resolved by keeping it adjacent to the table that owns it. 0010
--   header will note the dropped reference to avoid "wait why isn't
--   this in 0010" confusion when reading the bulk-index migration.
--
-- D6 — parser_version NOT NULL:
--   The dedupe UNIQUE (raw_input_hash, source_id, parser_version)
--   requires non-null parser_version to fire — Postgres treats NULL
--   as distinct in unique constraints. NOT NULL forces callers to be
--   explicit about which parser version emitted the row. No default;
--   callers must specify (e.g. 'driveco_json@1.0.0', 'fastned@2.1').
--
-- D7 — parser_outcomes is append-only:
--   No updated_at column, no updated_at trigger. Same shape as
--   tariff_history. If a row needs correction, insert a new outcome
--   with a newer parser_version and let the dedupe UNIQUE allow the
--   coexistence.

-- ─────────────────────────────────────────────────────────────────────────
-- ingestion_runs
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.ingestion_runs (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id       uuid         NOT NULL REFERENCES live.sources(id),

  started_at      timestamptz  NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  status          text         NOT NULL DEFAULT 'running',

  -- Row counters. All nullable — meaningful only once the run produces
  -- output. Per-counter CHECKs enforce non-negativity when set.
  rows_seen       integer,
  rows_inserted   integer,
  rows_updated    integer,
  rows_skipped    integer,

  error_message   text,
  git_sha         text,

  created_at      timestamptz  NOT NULL DEFAULT now(),
  updated_at      timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT ingestion_runs_status_enum CHECK (
    status IN ('running', 'success', 'failed', 'partial')
  ),
  -- D1: finished_at state machine. running ⇔ finished_at NULL.
  CONSTRAINT ingestion_runs_finished_at_state_machine CHECK (
    (status = 'running'  AND finished_at IS NULL)
    OR (status IN ('success', 'failed', 'partial') AND finished_at IS NOT NULL)
  ),
  CONSTRAINT ingestion_runs_finished_at_ordered CHECK (
    finished_at IS NULL OR finished_at >= started_at
  ),
  CONSTRAINT ingestion_runs_rows_seen_nonneg     CHECK (rows_seen     IS NULL OR rows_seen     >= 0),
  CONSTRAINT ingestion_runs_rows_inserted_nonneg CHECK (rows_inserted IS NULL OR rows_inserted >= 0),
  CONSTRAINT ingestion_runs_rows_updated_nonneg  CHECK (rows_updated  IS NULL OR rows_updated  >= 0),
  CONSTRAINT ingestion_runs_rows_skipped_nonneg  CHECK (rows_skipped  IS NULL OR rows_skipped  >= 0)
);

COMMENT ON TABLE live.ingestion_runs IS
  'One row per scheduled job execution (IRVE sync, scraper, parser pipeline). Powers freshness dashboard. State machine: running → success | failed | partial.';
COMMENT ON COLUMN live.ingestion_runs.status IS
  'running | success | failed | partial. partial = completed but rows_skipped>0 or error_message IS NOT NULL — application discipline, not CHECK-enforced.';
COMMENT ON COLUMN live.ingestion_runs.git_sha IS
  'Optional. Git commit of the worker that ran this job. Helps trace which version of the scraper/parser produced the row.';

-- updated_at trigger (reuse live.set_updated_at from 0002)
DROP TRIGGER IF EXISTS ingestion_runs_set_updated_at ON live.ingestion_runs;
CREATE TRIGGER ingestion_runs_set_updated_at
  BEFORE UPDATE ON live.ingestion_runs
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- parser_outcomes
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.parser_outcomes (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  ingestion_run_id    uuid         NOT NULL REFERENCES live.ingestion_runs(id) ON DELETE CASCADE,
  source_id           uuid         NOT NULL REFERENCES live.sources(id),

  raw_input           text         NOT NULL,
  -- sha256 hex, lowercase, exactly 64 chars. Application computes the
  -- hash before insert. Used for dedupe + parser regression replay.
  raw_input_hash      text         NOT NULL,

  outcome             text         NOT NULL,
  parsed_value_json   jsonb,
  error_message       text,
  -- D6: NOT NULL — required by the dedupe UNIQUE below. For source.kind
  -- = scraper rows, parser_version means "scraper version".
  parser_version      text         NOT NULL,

  occurred_at         timestamptz  NOT NULL DEFAULT now(),

  -- No created_at/updated_at — append-only audit log (D7).

  CONSTRAINT parser_outcomes_outcome_enum CHECK (
    outcome IN ('success', 'unknown', 'rejected', 'error')
  ),
  CONSTRAINT parser_outcomes_raw_input_hash_format CHECK (
    raw_input_hash ~ '^[0-9a-f]{64}$'
  ),
  -- D3: bound on raw_input size. 64 KB is comfortably above any real
  -- value (DRIVECO JSON ~2 KB, edge cases ~10 KB).
  CONSTRAINT parser_outcomes_raw_input_length CHECK (
    length(raw_input) <= 65536
  ),
  -- Dedupe: same input + same source + same parser version always
  -- yields the same outcome. Don't insert duplicates.
  CONSTRAINT parser_outcomes_dedupe_unique UNIQUE (raw_input_hash, source_id, parser_version)
);

CREATE INDEX IF NOT EXISTS parser_outcomes_run_idx     ON live.parser_outcomes (ingestion_run_id);
CREATE INDEX IF NOT EXISTS parser_outcomes_hash_idx    ON live.parser_outcomes (raw_input_hash);
CREATE INDEX IF NOT EXISTS parser_outcomes_outcome_idx ON live.parser_outcomes (outcome);

COMMENT ON TABLE live.parser_outcomes IS
  'Append-only audit log: one row per IRVE row / scraper item processed. Enables parser regression replay without re-downloading IRVE CSV. Dedupe via UNIQUE (raw_input_hash, source_id, parser_version).';
COMMENT ON COLUMN live.parser_outcomes.raw_input_hash IS
  'sha256 hex of raw_input, lowercase, exactly 64 chars. Application computes before insert. Format CHECK enforced.';
COMMENT ON COLUMN live.parser_outcomes.parsed_value_json IS
  'Free-form jsonb. No DB-side schema validation; application code (parser pipeline) is responsible for shape.';
COMMENT ON COLUMN live.parser_outcomes.parser_version IS
  'Parser semver, e.g. driveco_json@1.0.0. For source.kind=scraper, this is the scraper version. NOT NULL — required by the dedupe UNIQUE.';
COMMENT ON COLUMN live.parser_outcomes.outcome IS
  'success (parsed cleanly) | unknown (sentinel detector hit, no value extractable) | rejected (well-formed but disqualified) | error (parser threw).';
