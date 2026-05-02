-- Migration 0005 — Provenance: sources, station_tariffs, deferred-FK reconciliation
--
-- T04 final migration. Closes the deferred-FK loop opened in 0003 (subscriptions,
-- pass_markups) and 0004 (tariffs).
--
-- WHY HAND-ROLLED SQL (not Drizzle-Kit generated):
--   - The (confidence='unknown') = (tariff_id IS NULL) equivalence CHECK.
--   - The partial UNIQUE INDEX with COALESCE(...) expression on the
--     active-row natural key.
--   - The DO $$ … END $$ idempotent ADD CONSTRAINT blocks for the
--     deferred-FK reconciliation.
--   - Cross-table consistency trigger (station_tariffs.subscription_id ↔
--     payment_methods.kind), mirroring the C3 pattern from 0003.
--   Reuses live.set_updated_at() from 0002.
--
-- IDEMPOTENCY: every CREATE uses IF NOT EXISTS. INSERT … ON CONFLICT.
-- The deferred-FK ALTERs are wrapped in DO $$ … END $$ blocks that test
-- pg_constraint before adding. SET NOT NULL is natively idempotent on a
-- column already NOT NULL.
--
-- ENTITIES (per docs/02-architecture.md §1.2 + §1.4):
--   sources         — provenance lookup. Every row in subscriptions /
--                     pass_markups / tariffs / station_tariffs points
--                     here via source_id. Priority field drives "which
--                     row wins when multiple sources disagree" — lower
--                     priority = preferred.
--   station_tariffs — THE join carrying confidence. The product premise
--                     concentrates here: every visible price is a row
--                     in this table with one of 4 confidence tiers. The
--                     unknown↔NULL invariant (CHECK below) means we
--                     can never sneak a confident-looking number into
--                     a "we don't know" column.
--
-- CONFIDENCE TIER PROPAGATION (per docs/02-architecture.md §1.4):
--   DB layer:  station_tariffs.confidence ∈ {verified|parsed|estimated|unknown}
--   API layer: serializer enforces the unknown→null number rule on output.
--   UI layer:  per-row badge (✅ Vérifié / 📄 Estimé IRVE / 📊 Moyenne /
--              ❓ Non communiqué). Default sort: confidence desc, price asc.
--
-- DESIGN CALL — ACTIVE-ROW UNIQUENESS (override per T04 brief review):
--   Strict 3-tuple uniqueness on the active set. Partial UNIQUE INDEX on
--   (station_id, payment_method_id, COALESCE(subscription_id, sentinel))
--   WHERE valid_to IS NULL. Enforces "one active row per natural key at
--   any moment" — there is no API use case for dual-active rows.
--
--   The previous 4-tuple shape (with valid_from in the key) would have
--   permitted concurrently-active rows differing only in valid_from,
--   which the read serializer has no way to disambiguate. Strict
--   invariant > permissive flexibility.
--
--   History rows (valid_to IS NOT NULL) remain unconstrained — they
--   live outside the partial index entirely. Multiple history rows for
--   the same natural key, ordered by valid_from, are the intended
--   shape for price-change tracking.
--
-- DEFERRED-FK RECONCILIATION:
--   live.subscriptions.source_id, live.pass_markups.source_id, and
--   live.tariffs.source_id were declared `uuid` (nullable, no FK) in
--   0003 and 0004. This migration creates live.sources, seeds it (incl.
--   the 'manual_seed' priority-1000 backfill row), backfills any
--   pre-existing rows on those three tables, then SET NOT NULL + ADD
--   FOREIGN KEY for each. Idempotent via DO $$ … END $$ pg_constraint
--   guards.
--
-- OCPI REFERENCE: not directly. station_tariffs is a Prix-Bornes-side
-- concept that wraps OCPI Tariff rows with provenance and time-validity.

-- ─────────────────────────────────────────────────────────────────────────
-- sources
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.sources (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text         NOT NULL UNIQUE,
  display_name  text         NOT NULL,
  -- kind groups sources into broad categories. Drives default UI
  -- styling and priority bands (operator_correction at 0, scrapers
  -- 10–50, baseline dataset 100, parsers 200–500, manual_seed 1000).
  kind          text         NOT NULL,
  -- Lower priority = wins when multiple sources disagree on the same
  -- (station, payment_method, subscription) tuple. Allows future
  -- reordering without schema change.
  priority      integer      NOT NULL,
  description   text,
  website_url   text,
  -- Operational kill switch per docs/02-architecture.md §2.3. Setting
  -- is_enabled=false on a scraper row makes the cron handler return
  -- early and leaves existing data with a stale flag.
  is_enabled    boolean      NOT NULL DEFAULT TRUE,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT sources_slug_lowercase CHECK (slug = lower(slug) AND slug !~ '\s'),
  CONSTRAINT sources_kind_enum CHECK (
    kind IN ('dataset', 'parser', 'scraper', 'correction')
  ),
  CONSTRAINT sources_priority_nonneg CHECK (priority >= 0)
);

COMMENT ON TABLE live.sources IS
  'Provenance lookup. Every provenance-bearing row (subscriptions, pass_markups, tariffs, station_tariffs) points here via source_id. Priority drives conflict resolution.';
COMMENT ON COLUMN live.sources.priority IS
  'Lower = preferred when sources disagree. operator_correction=0, scrapers 10-50, baseline dataset 100, parsers 200-500, manual_seed 1000.';
COMMENT ON COLUMN live.sources.is_enabled IS
  'Operational kill switch (per docs/02-architecture.md §2.3). Scrapers should consult this before running.';

-- Seed 11 sources: 10 from the T04 brief + manual_seed for backfill.
-- ON CONFLICT (slug) DO NOTHING for re-apply safety.
INSERT INTO live.sources (slug, kind, priority, display_name, description) VALUES
  ('operator_correction',    'correction', 0,    'Operator-submitted correction',     'Operator-supplied price correction (always wins). Populated via the corrections table introduced in T05/0008.'),
  ('fastned_scraper',        'scraper',    10,   'Fastned tariff scraper',            'Weekly Vercel Cron job — fastnedcharging.com tariff page (T14, W5).'),
  ('electra_scraper',        'scraper',    20,   'Electra tariff scraper',            'Weekly scraper for go-electra.com price + Boost pages (M1.5, W7).'),
  ('chargemap_pass_scraper', 'scraper',    30,   'Chargemap pass markup scraper',     'Weekly scraper for chargemap.com pass-markup grid only (M1.5, W8). Per Phase 1 Q4: pass-grid scope only.'),
  ('irve_consolidated',      'dataset',    100,  'IRVE consolidated CSV (Etalab)',    'Daily IRVE consolidated dataset from data.gouv.fr (resource id eb76d20a-8501-400e-b336-d85724de5435).'),
  ('driveco_irve_json',      'parser',     200,  'DRIVECO JSON-in-IRVE parser',       'Parses the JSON DRIVECO emits inside the IRVE tarification text field (P0 in the parser pipeline, T10).'),
  ('citeos_template_parser', 'parser',     210,  'CITEOS template parser',            'Parses the CITEOS-style time-windowed template found in ~3.9 % of IRVE rows (P1, T11).'),
  ('regex_kwh_parser',       'parser',     300,  'Regex €/kWh parser',                'Multi-pattern €/kWh regex parser for the long tail (P2, T12).'),
  ('url_extractor',          'parser',     400,  'Tariff-URL extractor',              'Detects URL-only tarification values and stores the URL on stations.tariff_url (P3, T13).'),
  ('sentinel_detector',      'parser',     500,  'Sentinel/empty value detector',     'Maps empty / -, TRUE, FALSE, Inconnu, FIXE, the 12,890-row Power Dot disclaimer to confidence=unknown (P5, T09).'),
  ('manual_seed',            'correction', 1000, 'Manual seed (backfill safety)',     'Last-resort source attached to rows inserted before their authoring source row existed. Used by the deferred-FK backfill.')
ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- station_tariffs (the confidence-bearing join — product premise lives here)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.station_tariffs (
  id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),

  station_id          text           NOT NULL REFERENCES live.stations(id_station_itinerance) ON DELETE CASCADE,
  payment_method_id   uuid           NOT NULL REFERENCES live.payment_methods(id),

  -- Optional subscription. NULL = ad-hoc / cb-direct case. NOT NULL =
  -- subscription-bearing. Cross-table consistency with payment_method.kind
  -- enforced by the trigger below.
  subscription_id     uuid           REFERENCES live.subscriptions(id) ON DELETE SET NULL,

  -- The actual OCPI tariff. NULL iff confidence='unknown' (and vice versa) —
  -- enforced by the unknown↔NULL CHECK below.
  tariff_id           uuid           REFERENCES live.tariffs(id) ON DELETE SET NULL,

  -- The 4-tier confidence enum. This is the single most important column
  -- in the whole project — see docs/02-architecture.md §1.4.
  confidence          text           NOT NULL,

  -- Provenance — full FK from day one. No deferral. live.sources is created
  -- earlier in this same migration and seeded before this table is read.
  source_id           uuid           NOT NULL REFERENCES live.sources(id),
  parser_version      text,
  last_verified_at    timestamptz    NOT NULL DEFAULT now(),

  -- Time validity. valid_from defaults to insert time; valid_to NULL
  -- means "currently active." History is achieved by setting valid_to
  -- to NOW() and inserting a new active row.
  valid_from          timestamptz    NOT NULL DEFAULT now(),
  valid_to            timestamptz,

  created_at          timestamptz    NOT NULL DEFAULT now(),
  updated_at          timestamptz    NOT NULL DEFAULT now(),

  -- The 4-tier confidence enum.
  CONSTRAINT station_tariffs_confidence_enum CHECK (
    confidence IN ('verified', 'parsed', 'estimated', 'unknown')
  ),

  -- THE hard product invariant: confidence='unknown' iff tariff_id IS NULL.
  -- Equivalence, not implication. A 'verified' row MUST point to a tariff;
  -- an 'unknown' row MUST NOT.
  CONSTRAINT station_tariffs_unknown_implies_no_tariff CHECK (
    (confidence = 'unknown') = (tariff_id IS NULL)
  ),

  -- Validity ordered (NULL valid_to = currently active).
  CONSTRAINT station_tariffs_validity_ordered CHECK (
    valid_to IS NULL OR valid_to > valid_from
  )
);

-- Active-row uniqueness: strict 3-tuple per design call override.
-- COALESCE folds NULL subscription_id to a sentinel UUID so NULL == NULL
-- in the unique index (Postgres otherwise treats NULL as distinct).
-- valid_from intentionally NOT in the key — at most one active row per
-- (station, payment_method, subscription) at any moment.
CREATE UNIQUE INDEX IF NOT EXISTS station_tariffs_active_unique
  ON live.station_tariffs (
    station_id,
    payment_method_id,
    COALESCE(subscription_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE valid_to IS NULL;

-- Read-path indexes per T04 brief §3.
CREATE INDEX IF NOT EXISTS station_tariffs_station_idx
  ON live.station_tariffs (station_id);

CREATE INDEX IF NOT EXISTS station_tariffs_payment_method_idx
  ON live.station_tariffs (payment_method_id);

CREATE INDEX IF NOT EXISTS station_tariffs_confidence_idx
  ON live.station_tariffs (confidence);

-- Partial index for "current price at this station for this payment"
-- queries. Used by the API serializer's hot path.
CREATE INDEX IF NOT EXISTS station_tariffs_active_idx
  ON live.station_tariffs (station_id, payment_method_id)
  WHERE valid_to IS NULL;

COMMENT ON TABLE live.station_tariffs IS
  'The 4-tier confidence-bearing join. THE product premise lives here. Per docs/02-architecture.md §1.4: confidence propagates DB → API → UI without losing meaning.';
COMMENT ON COLUMN live.station_tariffs.confidence IS
  'verified | parsed | estimated | unknown. confidence=unknown ⇔ tariff_id IS NULL (CHECK enforced).';
COMMENT ON COLUMN live.station_tariffs.parser_version IS
  'Semver of the parser that emitted this row (when source.kind = parser). Enables regression replay against parser_outcomes (T05).';
COMMENT ON COLUMN live.station_tariffs.valid_from IS
  'When this tariff started applying at this station. Defaults to insert time.';
COMMENT ON COLUMN live.station_tariffs.valid_to IS
  'When this tariff stopped applying. NULL = currently active. Set to NOW() (and a new row inserted) on supersession.';

-- ─────────────────────────────────────────────────────────────────────────
-- Cross-table invariant: station_tariffs.subscription_id IS NOT NULL must
-- imply payment_method.kind ∈ {operator_subscription, roaming_pass}.
-- Mirrors the C3 trigger pattern from 0003 (pass_markups).
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION live.check_station_tariff_subscription_consistency()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  pm_kind text;
BEGIN
  -- Only validate when subscription_id is set. NULL subscription_id is
  -- valid for any payment_method (e.g. cb_ad_hoc with no plan).
  IF NEW.subscription_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT kind INTO pm_kind
    FROM live.payment_methods
    WHERE id = NEW.payment_method_id;

  IF pm_kind IS NULL THEN
    -- payment_method_id missing — let the FK constraint produce its
    -- standard error. (FK fires after this trigger.)
    RETURN NEW;
  END IF;

  IF pm_kind NOT IN ('operator_subscription', 'roaming_pass') THEN
    RAISE EXCEPTION
      'station_tariffs.subscription_id requires payment_method.kind in (operator_subscription, roaming_pass), got % for payment_method_id %',
      pm_kind, NEW.payment_method_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS station_tariffs_subscription_consistency_check ON live.station_tariffs;
CREATE TRIGGER station_tariffs_subscription_consistency_check
  BEFORE INSERT OR UPDATE OF subscription_id, payment_method_id ON live.station_tariffs
  FOR EACH ROW EXECUTE FUNCTION live.check_station_tariff_subscription_consistency();

-- ─────────────────────────────────────────────────────────────────────────
-- updated_at triggers (reuse live.set_updated_at from 0002)
-- ─────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS sources_set_updated_at ON live.sources;
CREATE TRIGGER sources_set_updated_at
  BEFORE UPDATE ON live.sources
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();

DROP TRIGGER IF EXISTS station_tariffs_set_updated_at ON live.station_tariffs;
CREATE TRIGGER station_tariffs_set_updated_at
  BEFORE UPDATE ON live.station_tariffs
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- Deferred-FK reconciliation: subscriptions, pass_markups, tariffs.
--
-- Each block:
--   1. Backfills NULL source_id rows to the manual_seed source.
--   2. Sets the column NOT NULL (idempotent on already-NOT-NULL).
--   3. Adds the FK to live.sources, guarded against duplicate creation
--      via pg_constraint lookup (DO $$ … END $$).
--
-- In normal flow no rows exist on these tables when 0005 runs, so the
-- backfill UPDATEs are no-ops. They exist as insurance against partial
-- apply or out-of-order seed scripts.
-- ─────────────────────────────────────────────────────────────────────────

-- subscriptions
UPDATE live.subscriptions
   SET source_id = (SELECT id FROM live.sources WHERE slug = 'manual_seed')
 WHERE source_id IS NULL;
ALTER TABLE live.subscriptions ALTER COLUMN source_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'subscriptions_source_id_fkey'
       AND connamespace = 'live'::regnamespace
  ) THEN
    ALTER TABLE live.subscriptions
      ADD CONSTRAINT subscriptions_source_id_fkey
      FOREIGN KEY (source_id) REFERENCES live.sources(id);
  END IF;
END $$;

-- pass_markups
UPDATE live.pass_markups
   SET source_id = (SELECT id FROM live.sources WHERE slug = 'manual_seed')
 WHERE source_id IS NULL;
ALTER TABLE live.pass_markups ALTER COLUMN source_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'pass_markups_source_id_fkey'
       AND connamespace = 'live'::regnamespace
  ) THEN
    ALTER TABLE live.pass_markups
      ADD CONSTRAINT pass_markups_source_id_fkey
      FOREIGN KEY (source_id) REFERENCES live.sources(id);
  END IF;
END $$;

-- tariffs
UPDATE live.tariffs
   SET source_id = (SELECT id FROM live.sources WHERE slug = 'manual_seed')
 WHERE source_id IS NULL;
ALTER TABLE live.tariffs ALTER COLUMN source_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'tariffs_source_id_fkey'
       AND connamespace = 'live'::regnamespace
  ) THEN
    ALTER TABLE live.tariffs
      ADD CONSTRAINT tariffs_source_id_fkey
      FOREIGN KEY (source_id) REFERENCES live.sources(id);
  END IF;
END $$;
