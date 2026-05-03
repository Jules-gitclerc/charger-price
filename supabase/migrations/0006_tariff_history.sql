-- Migration 0006 — tariff_history (partitioned by month from migration 1)
--
-- T05, M1 W2.
--
-- WHY HAND-ROLLED SQL (not Drizzle-Kit generated):
--   Partitioned tables, partition pre-creation via plpgsql DO loop,
--   composite PK (required by Postgres for partitioned tables —
--   PK must include the partition key), and the trigger function with
--   TG_OP branching on station_tariffs are all clearer in raw SQL.
--   Reuses live.set_updated_at() — actually NOT used here: tariff_history
--   is append-only, no updated_at column.
--
-- IDEMPOTENCY: every CREATE uses IF NOT EXISTS. Triggers use DROP IF
-- EXISTS + CREATE. Functions use CREATE OR REPLACE. The seed
-- ensure_tariff_history_partitions(11) call inside DO $$ is harmless
-- on re-apply (every partition CREATE TABLE IF NOT EXISTS no-ops).
--
-- ENTITIES (per docs/02-architecture.md §1.2 + §A5 trade-off):
--   tariff_history — append-only snapshot of every state station_tariffs
--                    has ever been in. Partitioned BY RANGE on snapshot_at,
--                    monthly granularity, pre-created 12 months ahead from
--                    current month (May 2026 → April 2027).
--
-- PHASE 2 TRADE-OFF #1 / §A5 COMMITMENT (per T04 brief and PROJECT plan):
--   tariff_history is partitioned from its first migration, NOT as a
--   later optimization. Phase 2 A5 explicitly: "Partitioning by month
--   from day one is cheap insurance; doing it later is painful." This
--   migration implements that commitment.
--
-- DESIGN CALL — SNAPSHOT SEMANTICS (T05 brief override of Phase 2 §1.2):
--   On INSERT: snapshot NEW (the row that just started existing),
--              change_kind='insert'. snapshot_at = when this state
--              started being true.
--   On UPDATE: snapshot NEW (the post-change state — the state that
--              just started being true). change_kind='update'.
--              Phase 2 §1.2 originally described OLD semantics ("writes
--              the previous row here"); T05 brief overrode to NEW so
--              snapshot_at consistently reads as "when this state
--              started being true," and reconstruction at time T does
--              not need a `change_kind != 'delete'` filter on the
--              latest-row lookup.
--   On DELETE: snapshot OLD (the row being deleted). Asymmetric with
--              INSERT/UPDATE but unavoidable — there is no NEW on a
--              DELETE; we record what was destroyed.
--              change_kind='delete'.
--
--   Reading semantics: to reconstruct row state at time T, take the
--   latest history row with snapshot_at <= T. If the latest is
--   change_kind='delete', the row didn't exist at T. Otherwise its
--   snapshot mirrors the row's state at T. The live station_tariffs
--   row's current state equals the latest non-delete history row's
--   snapshot under steady-state single-writer assumptions.
--
-- DESIGN CALL — NO FK ON station_tariff_id:
--   tariff_history.station_tariff_id is uuid NOT NULL but does NOT
--   reference live.station_tariffs(id). History must outlive
--   deletion of the live row — that's the whole point. Equivalent to
--   how audit logs in financial systems decouple from the entities they
--   describe.
--
-- DESIGN CALL — COMPOSITE PK (id, snapshot_at):
--   Postgres requires the partition key (snapshot_at) to be part of
--   any PRIMARY KEY on a partitioned table. id alone is functionally
--   unique (UUIDv4) but the constraint must include snapshot_at.
--
-- PARTITION ROLLOVER CONTRACT:
--   live.ensure_tariff_history_partitions(months_ahead int) RETURNS int
--     - Ensures partitions exist for [current_month, current_month + months_ahead] INCLUSIVE.
--     - months_ahead=11 → 12 partitions (current + 11 future).
--     - months_ahead=0  → just the current month.
--     - Returns the number of partition iterations performed (NOT the
--       number actually created — Postgres CREATE IF NOT EXISTS gives
--       no signal). Future cron can compare pg_class counts before/after
--       if a "newly created" metric is needed.
--   Future GitHub Action cron (T08+ territory, NOT this migration) will
--   call this monthly to roll the window forward, e.g.:
--     SELECT live.ensure_tariff_history_partitions(2);
--   on the 25th of each month to ensure the next-2-months partitions
--   exist before INSERT traffic could hit them.

-- ─────────────────────────────────────────────────────────────────────────
-- tariff_history (partitioned parent)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.tariff_history (
  -- Composite PK: id + snapshot_at (partition key required by Postgres).
  id                  uuid           NOT NULL DEFAULT gen_random_uuid(),

  -- The station_tariffs.id this row snapshots. NOT a FK — history
  -- outlives row deletion (see header design call).
  station_tariff_id   uuid           NOT NULL,

  -- Snapshot columns: full mirror of station_tariffs row state at the
  -- moment the trigger fired. NOT FKs — same outlive-deletion rationale.
  station_id          text           NOT NULL,
  payment_method_id   uuid           NOT NULL,
  subscription_id     uuid,
  tariff_id           uuid,
  confidence          text           NOT NULL,
  source_id           uuid           NOT NULL,
  parser_version      text,
  last_verified_at    timestamptz    NOT NULL,
  valid_from          timestamptz    NOT NULL,
  valid_to            timestamptz,

  -- Partition key + change kind.
  snapshot_at         timestamptz    NOT NULL DEFAULT now(),
  change_kind         text           NOT NULL,

  PRIMARY KEY (id, snapshot_at),
  CONSTRAINT tariff_history_change_kind_enum CHECK (
    change_kind IN ('insert', 'update', 'delete')
  ),
  CONSTRAINT tariff_history_confidence_enum CHECK (
    confidence IN ('verified', 'parsed', 'estimated', 'unknown')
  )
)
PARTITION BY RANGE (snapshot_at);

COMMENT ON TABLE live.tariff_history IS
  'Append-only snapshot of station_tariffs state. Partitioned BY RANGE on snapshot_at, monthly. Phase 2 §A5 commitment: partitioned from migration 0006, not retrofitted.';
COMMENT ON COLUMN live.tariff_history.station_tariff_id IS
  'live.station_tariffs.id at snapshot time. NOT a FK — history outlives row deletion.';
COMMENT ON COLUMN live.tariff_history.change_kind IS
  'insert | update | delete. UPDATE rows snapshot the OLD (pre-change) state per docs/02-architecture.md §1.2.';
COMMENT ON COLUMN live.tariff_history.snapshot_at IS
  'Partition key. Defaults to trigger-fire time (now()).';

-- Useful read-path index for "show me the history of this row" queries
-- on the station detail page (M2 surface). Created on the parent;
-- Postgres propagates to all partitions.
CREATE INDEX IF NOT EXISTS tariff_history_station_tariff_idx
  ON live.tariff_history (station_tariff_id, snapshot_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- ensure_tariff_history_partitions: idempotent partition creator
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION live.ensure_tariff_history_partitions(months_ahead integer)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  -- All bound computation uses UTC explicitly. snapshot_at is timestamptz;
  -- partition bounds emitted as 'YYYY-MM-DD 00:00:00+00' strings so the
  -- UTC offset is unambiguous regardless of session TimeZone setting.
  -- Critical: do NOT cast a bare date as a partition bound — Postgres
  -- would interpret it at session-local midnight, which on the
  -- Paris→UTC boundary (e.g. April 30 → May 1) flips into the wrong
  -- partition.
  current_month     date;
  start_date        date;
  end_date          date;
  start_bound_text  text;
  end_bound_text    text;
  partition_name    text;
  iterations        integer := 0;
BEGIN
  IF months_ahead < 0 THEN
    RAISE EXCEPTION 'months_ahead must be >= 0, got %', months_ahead;
  END IF;

  current_month := date_trunc('month', CURRENT_DATE)::date;

  FOR i IN 0..months_ahead LOOP
    start_date := (current_month + (i || ' months')::interval)::date;
    end_date   := (current_month + ((i + 1) || ' months')::interval)::date;

    -- Explicit UTC midnight bounds: 'YYYY-MM-DD 00:00:00+00'.
    -- Half-open interval [start_bound, end_bound) per Postgres RANGE
    -- partitioning convention.
    start_bound_text := to_char(start_date, 'YYYY-MM-DD') || ' 00:00:00+00';
    end_bound_text   := to_char(end_date,   'YYYY-MM-DD') || ' 00:00:00+00';

    partition_name := format('tariff_history_%s', to_char(start_date, 'YYYY_MM'));

    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS live.%I PARTITION OF live.tariff_history FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_bound_text, end_bound_text
    );

    iterations := iterations + 1;
  END LOOP;

  RETURN iterations;
END;
$$;

COMMENT ON FUNCTION live.ensure_tariff_history_partitions(integer) IS
  'Idempotent partition creator for live.tariff_history. months_ahead=11 ensures the current month + next 11 months. Future cron rollover calls this. Returns iteration count, not "newly created" count.';

-- Initial seed: 12 partitions covering current month + next 11.
-- Wrapped in DO $$ so we can call the function during migration apply.
DO $$
BEGIN
  PERFORM live.ensure_tariff_history_partitions(11);
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- Trigger: snapshot every state change on live.station_tariffs
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION live.snapshot_station_tariff()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO live.tariff_history (
      station_tariff_id, station_id, payment_method_id, subscription_id, tariff_id,
      confidence, source_id, parser_version, last_verified_at, valid_from, valid_to,
      change_kind
    ) VALUES (
      NEW.id, NEW.station_id, NEW.payment_method_id, NEW.subscription_id, NEW.tariff_id,
      NEW.confidence, NEW.source_id, NEW.parser_version, NEW.last_verified_at,
      NEW.valid_from, NEW.valid_to,
      'insert'
    );
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Snapshot NEW (post-change state) per T05 brief override. The
    -- snapshot_at timestamp marks when the NEW state started being true.
    INSERT INTO live.tariff_history (
      station_tariff_id, station_id, payment_method_id, subscription_id, tariff_id,
      confidence, source_id, parser_version, last_verified_at, valid_from, valid_to,
      change_kind
    ) VALUES (
      NEW.id, NEW.station_id, NEW.payment_method_id, NEW.subscription_id, NEW.tariff_id,
      NEW.confidence, NEW.source_id, NEW.parser_version, NEW.last_verified_at,
      NEW.valid_from, NEW.valid_to,
      'update'
    );
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO live.tariff_history (
      station_tariff_id, station_id, payment_method_id, subscription_id, tariff_id,
      confidence, source_id, parser_version, last_verified_at, valid_from, valid_to,
      change_kind
    ) VALUES (
      OLD.id, OLD.station_id, OLD.payment_method_id, OLD.subscription_id, OLD.tariff_id,
      OLD.confidence, OLD.source_id, OLD.parser_version, OLD.last_verified_at,
      OLD.valid_from, OLD.valid_to,
      'delete'
    );
    RETURN OLD;
  END IF;

  RETURN NULL; -- unreachable; satisfy plpgsql trigger return contract
END;
$$;

DROP TRIGGER IF EXISTS station_tariffs_history_snapshot ON live.station_tariffs;
CREATE TRIGGER station_tariffs_history_snapshot
  AFTER INSERT OR UPDATE OR DELETE ON live.station_tariffs
  FOR EACH ROW EXECUTE FUNCTION live.snapshot_station_tariff();
