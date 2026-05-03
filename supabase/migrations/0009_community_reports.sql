-- Migration 0009 — community_reports (schema-only, cold table until M3)
--
-- T05, M1 W2.
--
-- WHY HAND-ROLLED SQL (not Drizzle-Kit generated):
--   The has-a-value CHECK (price OR session_total — kWh deliberately
--   excluded), enum CHECK, length CHECKs on session id and comment,
--   and the partial pending-queue UNIQUE index are clearer in raw SQL.
--   Reuses live.set_updated_at() from 0002.
--
-- IDEMPOTENCY: every CREATE uses IF NOT EXISTS. Triggers use DROP IF
-- EXISTS + CREATE.
--
-- ENTITIES (per docs/02-architecture.md §1.2 + Phase 1 Q6 + T05 brief):
--   community_reports — schema-only cold table. NO INSERT trigger, NO
--                       API endpoint, NO UI surface in M1. Populated
--                       in M3 when the community-feedback submission
--                       form ships. Until then, the table exists so
--                       application code can target it via type-safe
--                       schemas without future breaking migrations.
--
-- PHASE 1 Q6 / docs/02-architecture.md §A2 COMMITMENT:
--   "Should we already start emitting telemetry (anonymous 'this
--   station's price feels wrong' signal) without a submission form?
--   My read: no, that's surveillance dressed up as feedback. Wait for
--   M3."
--   This migration ships the schema; M3 ships the form. NO writes
--   land here in M1.
--
-- DESIGN CALLS (per T05 brief §0009 review):
--
-- D1 — reported_by_session_id opacity:
--   text NOT NULL, no FK, no link to any user table (we don't have
--   one anyway). Column COMMENT spells out the no-PII contract:
--   opaque client-generated identifier, used only for rate-limit
--   deduplication of submissions from the same client during the same
--   session. Phase 1 ruling: no stealth telemetry — this column is
--   the discipline-encoded version of that ruling.
--
-- D2 — Length CHECKs:
--   reported_by_session_id <= 128 chars (UUID + namespace prefix room,
--                                        rejects pasted JSON).
--   comment <= 4096 chars (user-facing free text; longer goes to
--                          corrections@).
--
-- D3 — Numeric range CHECKs:
--   Lower bound only (>= 0 if NOT NULL) on price, kwh, session_total.
--   No upper bound — €999/kWh is a moderation signal, not an error
--   to reject. Moderator handles outliers.
--
-- D4 — reported_kwh orphan policy:
--   NOT in the has-a-value CHECK. The user can report kWh as
--   informational metadata, but the submission only counts as a price
--   report if reported_price_eur OR reported_session_total_eur is set.
--   "Just kWh, no price" is rejected by the has-a-value CHECK.
--
-- D5 — CASCADE on station_id deletion:
--   When a station disappears from IRVE (de-listed by the operator),
--   its community reports go too. We're not running an analytics
--   warehouse here; if we wanted post-deletion analysis we'd export
--   to archive. Per T05 brief.
--
-- D6 — payment_method_id NOT NULL:
--   A submission without a payment method is unactionable. The M3
--   submission form will require selection (no "I don't know" option
--   needed in M1 schema; if it ever does, that's an additive
--   migration adding an 'unknown' payment_methods seed row).
--
-- D7 — Moderation pending-queue partial index:
--   community_reports_pending_queue_idx ON (reported_at DESC) WHERE
--   status='pending'. Same pattern as 0008 corrections_pending_queue_idx
--   and 0007 parser_outcomes_hash_idx — index lives in the migration
--   that creates the table, not in 0010. 0010 header documents the
--   resolved overlap.

-- ─────────────────────────────────────────────────────────────────────────
-- community_reports
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.community_reports (
  id                            uuid           PRIMARY KEY DEFAULT gen_random_uuid(),

  station_id                    text           NOT NULL REFERENCES live.stations(id_station_itinerance) ON DELETE CASCADE,
  payment_method_id             uuid           NOT NULL REFERENCES live.payment_methods(id),

  -- D1: opaque client identifier. No FK, no PII contract. See COMMENT.
  reported_by_session_id        text           NOT NULL,
  reported_at                   timestamptz    NOT NULL DEFAULT now(),

  -- D3+D4: numeric reports. Each individually nullable. price + total
  -- carry the at-least-one invariant; kwh is informational only.
  reported_price_eur            numeric(10,4),
  reported_kwh                  numeric(10,3),
  reported_session_total_eur    numeric(10,4),

  -- D2: 4096 char ceiling on free-text comment.
  comment                       text,

  status                        text           NOT NULL DEFAULT 'pending',

  created_at                    timestamptz    NOT NULL DEFAULT now(),
  updated_at                    timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT community_reports_status_enum CHECK (
    status IN ('pending', 'reviewed', 'incorporated', 'rejected')
  ),
  -- D4: at least one of price OR total. kWh excluded — informational.
  CONSTRAINT community_reports_has_a_value CHECK (
    reported_price_eur IS NOT NULL OR reported_session_total_eur IS NOT NULL
  ),
  CONSTRAINT community_reports_session_id_length CHECK (
    length(reported_by_session_id) > 0 AND length(reported_by_session_id) <= 128
  ),
  CONSTRAINT community_reports_comment_length CHECK (
    comment IS NULL OR length(comment) <= 4096
  ),
  CONSTRAINT community_reports_price_nonneg CHECK (
    reported_price_eur IS NULL OR reported_price_eur >= 0
  ),
  CONSTRAINT community_reports_kwh_nonneg CHECK (
    reported_kwh IS NULL OR reported_kwh >= 0
  ),
  CONSTRAINT community_reports_session_total_nonneg CHECK (
    reported_session_total_eur IS NULL OR reported_session_total_eur >= 0
  )
);

CREATE INDEX IF NOT EXISTS community_reports_status_idx        ON live.community_reports (status);
CREATE INDEX IF NOT EXISTS community_reports_station_idx       ON live.community_reports (station_id);
CREATE INDEX IF NOT EXISTS community_reports_reported_at_idx   ON live.community_reports (reported_at DESC);
-- D7: partial pending-queue index (overlap with 0010 resolved here).
CREATE INDEX IF NOT EXISTS community_reports_pending_queue_idx
  ON live.community_reports (reported_at DESC)
  WHERE status = 'pending';

COMMENT ON TABLE live.community_reports IS
  'Schema-only cold table. NO INSERT trigger, NO API endpoint, NO UI surface in M1. Populated in M3 when the community-feedback submission form ships. Phase 1 Q6: "no surveillance dressed up as feedback — wait for M3."';
COMMENT ON COLUMN live.community_reports.reported_by_session_id IS
  'Opaque client-generated identifier. NOT a user ID. NOT joinable to any other table. Used only for rate-limit deduplication of submissions from the same client during the same session. Phase 1 no-stealth-telemetry ruling encoded as schema discipline.';
COMMENT ON COLUMN live.community_reports.reported_kwh IS
  'Optional informational kWh value. NOT part of the has-a-value CHECK — a submission must carry reported_price_eur OR reported_session_total_eur to count as a price report.';
COMMENT ON COLUMN live.community_reports.status IS
  'pending | reviewed | incorporated | rejected. M3 moderation queue surfaces pending rows; incorporated rows feed station_tariffs at moderator discretion.';

DROP TRIGGER IF EXISTS community_reports_set_updated_at ON live.community_reports;
CREATE TRIGGER community_reports_set_updated_at
  BEFORE UPDATE ON live.community_reports
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();
