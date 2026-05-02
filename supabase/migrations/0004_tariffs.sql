-- Migration 0004 — Tariffs (full OCPI 2.2.1 shape)
--
-- T04, M1 W2.
--
-- WHY HAND-ROLLED SQL (not Drizzle-Kit generated):
--   OCPI's enum-heavy structure (tariff_type, price_components.type,
--   tariff_restrictions.reservation, day_of_week array containment),
--   the deferred FK pattern for source_id (mirroring 0003), and the
--   ordering CHECKs (valid_from < valid_to, min ≤ max for kWh / power
--   / current / duration / date / price) are all clearer in raw SQL.
--   Reuses live.set_updated_at() from 0002.
--
-- IDEMPOTENCY: every CREATE uses IF NOT EXISTS. Triggers use DROP IF
-- EXISTS + CREATE.
--
-- OCPI REFERENCE: https://github.com/ocpi/ocpi (mod_tariffs.asciidoc,
-- v2.2.1). Field names and enum members track the spec verbatim where
-- meaningful.
--
-- ENTITIES (per docs/02-architecture.md §1.2):
--   tariffs              — OCPI Tariff. Identified by slug; carries
--                          currency, validity window, optional price
--                          bounds. Provenance via source_id (FK added
--                          in 0005). NO confidence / parser_version /
--                          last_verified_at — a tariff is a structural
--                          definition; the "is this current at this
--                          station" question lives on station_tariffs
--                          (0005).
--   tariff_elements      — Ordered children of a tariff. 1..N per
--                          tariff, ordered by sequence_number.
--   price_components     — Children of an element. 1..N per element.
--                          OCPI types: ENERGY (kWh) | TIME (hr) |
--                          FLAT (per session) | PARKING_TIME (hr).
--   tariff_restrictions  — 0..1 per element (UNIQUE on tariff_element_id
--                          per design call (a) — strict OCPI 1:0..1
--                          cardinality. OR-restricted prices are modeled
--                          as separate tariff_elements with shared
--                          price_components, matching how CITEOS-style
--                          publishers emit them and matching what an
--                          OCPI round-trip expects).
--
-- ASYMMETRIC PROVENANCE (per T04 brief discrepancy #2 ruling):
--   tariffs              → source_id only. No last_verified_at, no
--                          confidence, no parser_version.
--   tariff_elements,
--   price_components,
--   tariff_restrictions  → no provenance columns at all. They are
--                          structural children of a tariff; provenance
--                          lives on the parent. Updating a price means
--                          a new tariff (or a new tariff_element with
--                          a later sequence_number, application-side).
--
-- DEFERRED FK + DEFERRED NOT NULL on tariffs.source_id (per T04 brief
-- correction C1, mirroring 0003):
--   live.sources is created in migration 0005. tariffs.source_id is
--   declared `uuid` (nullable, no FK) here. Migration 0005 will:
--     UPDATE live.tariffs SET source_id = (SELECT id FROM live.sources
--       WHERE slug = 'manual_seed') WHERE source_id IS NULL;
--     ALTER TABLE live.tariffs ALTER COLUMN source_id SET NOT NULL;
--     ALTER TABLE live.tariffs ADD CONSTRAINT tariffs_source_id_fkey
--       FOREIGN KEY (source_id) REFERENCES live.sources(id);

-- ─────────────────────────────────────────────────────────────────────────
-- tariffs
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.tariffs (
  id              uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text           NOT NULL UNIQUE,
  display_name    text           NOT NULL,
  description     text,

  -- OCPI tariff_type. Drives API derivation of which payment_method
  -- shape applies (cb_ad_hoc / operator_subscription / etc.).
  tariff_type     text           NOT NULL,

  -- ISO 4217. char(3) lets us validate length and uppercase via CHECK.
  currency        char(3)        NOT NULL DEFAULT 'EUR',

  -- Optional validity window. Both nullable for "always-active" tariffs.
  valid_from      timestamptz,
  valid_to        timestamptz,

  -- Optional bounds for ad-hoc display. OCPI calls these min_price/
  -- max_price; we suffix _eur because we may want a multi-currency
  -- variant later but for now everything is EUR.
  min_price_eur   numeric(10,4),
  max_price_eur   numeric(10,4),

  -- OCPI tax_included tri-state. NULL = unknown (operator didn't say or
  -- scraper couldn't determine), TRUE = TTC (price includes VAT),
  -- FALSE = HT (price excludes VAT). No CHECK — three-valued semantics
  -- are intentional and consistent with VAT nullability on
  -- price_components.
  tax_included    boolean,

  -- Provenance. Nullable in 0004; 0005 backfills, sets NOT NULL, adds FK.
  source_id       uuid,

  created_at      timestamptz    NOT NULL DEFAULT now(),
  updated_at      timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT tariffs_slug_lowercase CHECK (slug = lower(slug) AND slug !~ '\s'),
  CONSTRAINT tariffs_currency_iso CHECK (
    currency = upper(currency) AND length(currency) = 3
  ),
  CONSTRAINT tariffs_type_enum CHECK (
    tariff_type IN ('AD_HOC', 'PROFILE_CHEAP', 'PROFILE_FAST', 'PROFILE_GREEN', 'REGULAR')
  ),
  CONSTRAINT tariffs_validity_ordered CHECK (
    valid_to IS NULL OR valid_from IS NULL OR valid_to > valid_from
  ),
  CONSTRAINT tariffs_min_price_nonneg CHECK (min_price_eur IS NULL OR min_price_eur >= 0),
  CONSTRAINT tariffs_max_price_nonneg CHECK (max_price_eur IS NULL OR max_price_eur >= 0),
  CONSTRAINT tariffs_price_bounds_ordered CHECK (
    min_price_eur IS NULL OR max_price_eur IS NULL OR max_price_eur >= min_price_eur
  )
);

COMMENT ON TABLE live.tariffs IS
  'OCPI 2.2.1 Tariff. Identified by slug. Provenance via source_id only — no confidence/last_verified_at/parser_version (those live on station_tariffs in 0005).';
COMMENT ON COLUMN live.tariffs.tariff_type IS
  'OCPI tariff_type: AD_HOC | PROFILE_CHEAP | PROFILE_FAST | PROFILE_GREEN | REGULAR.';
COMMENT ON COLUMN live.tariffs.tax_included IS
  'OCPI tax_included tri-state. NULL = unknown, TRUE = TTC, FALSE = HT. No CHECK — three-valued semantics are intentional.';
COMMENT ON COLUMN live.tariffs.source_id IS
  'Nullable in 0004. Migration 0005 backfills to manual_seed source, sets NOT NULL, adds FK to live.sources.';

-- ─────────────────────────────────────────────────────────────────────────
-- tariff_elements
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.tariff_elements (
  id               uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  tariff_id        uuid         NOT NULL REFERENCES live.tariffs(id) ON DELETE CASCADE,

  -- API ordering: lower sequence_number is evaluated first (OCPI says
  -- "the first matching element wins"). 0-based for ergonomics.
  sequence_number  integer      NOT NULL,

  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT tariff_elements_sequence_nonneg CHECK (sequence_number >= 0),
  CONSTRAINT tariff_elements_tariff_sequence_unique UNIQUE (tariff_id, sequence_number)
);

CREATE INDEX IF NOT EXISTS tariff_elements_tariff_idx ON live.tariff_elements (tariff_id);

COMMENT ON TABLE live.tariff_elements IS
  'OCPI TariffElement. Ordered children of a tariff (lower sequence_number = evaluated first).';

-- ─────────────────────────────────────────────────────────────────────────
-- price_components
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.price_components (
  id                 uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  tariff_element_id  uuid           NOT NULL REFERENCES live.tariff_elements(id) ON DELETE CASCADE,

  -- OCPI PriceComponent.type. ENERGY = €/kWh, TIME = €/hour during
  -- charging, FLAT = € per session, PARKING_TIME = €/hour while parked
  -- but not charging.
  type               text           NOT NULL,

  -- Per OCPI: amount per unit (depends on `type`). Whether the amount
  -- is TTC (tax-inclusive) or HT is recorded on the parent tariff's
  -- tax_included tri-state — not here. Per-component VAT % is captured
  -- in the `vat` column below for operators that publish it.
  price              numeric(10,4)  NOT NULL,

  -- VAT %. Optional (some operators publish HT, others TTC, others
  -- decline to disclose). NULL = unknown rather than 0.
  vat                numeric(5,2),

  -- OCPI step_size: billing increment in the unit of `type`. ENERGY:
  -- 1 = bill per Wh; 1000 = bill per kWh. TIME: 1 = bill per second.
  -- Positive integer; 0 makes no sense.
  step_size          integer        NOT NULL DEFAULT 1,

  created_at         timestamptz    NOT NULL DEFAULT now(),
  updated_at         timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT price_components_type_enum CHECK (
    type IN ('ENERGY', 'TIME', 'FLAT', 'PARKING_TIME')
  ),
  CONSTRAINT price_components_price_nonneg CHECK (price >= 0),
  CONSTRAINT price_components_vat_nonneg CHECK (vat IS NULL OR vat >= 0),
  CONSTRAINT price_components_step_size_positive CHECK (step_size >= 1)
);

CREATE INDEX IF NOT EXISTS price_components_element_idx ON live.price_components (tariff_element_id);

COMMENT ON TABLE live.price_components IS
  'OCPI PriceComponent. Children of a tariff_element. type ∈ ENERGY (kWh) | TIME (hr) | FLAT (session) | PARKING_TIME (hr).';
COMMENT ON COLUMN live.price_components.step_size IS
  'OCPI billing increment. ENERGY: 1 = per Wh, 1000 = per kWh. TIME: 1 = per second, 60 = per minute.';
COMMENT ON COLUMN live.price_components.vat IS
  'VAT %. NULL = unknown (rather than 0 — some operators decline to disclose).';

-- ─────────────────────────────────────────────────────────────────────────
-- tariff_restrictions
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.tariff_restrictions (
  id                 uuid           PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 0..1 per element per design call (a) — strict OCPI cardinality.
  -- OR-restricted prices are modeled as separate tariff_elements with
  -- shared price_components.
  tariff_element_id  uuid           NOT NULL REFERENCES live.tariff_elements(id) ON DELETE CASCADE,

  -- Time-of-day window (local time, "HH:MM"). Both nullable for "any time."
  start_time         text,
  end_time           text,

  -- Date window.
  start_date         date,
  end_date           date,

  -- Energy thresholds (kWh).
  min_kwh            numeric(10,2),
  max_kwh            numeric(10,2),

  -- Current thresholds (Amps).
  min_current        numeric(7,2),
  max_current        numeric(7,2),

  -- Power thresholds (kW). Drives "≤50 kW vs >50 kW" tier matching
  -- (TotalEnergies-style, per Phase 1 A.1).
  min_power          numeric(7,2),
  max_power          numeric(7,2),

  -- Session duration thresholds (seconds, per OCPI).
  min_duration       integer,
  max_duration       integer,

  -- Day-of-week filter. NULL = any day. Each element must be one of
  -- the OCPI day-of-week strings.
  day_of_week        text[],

  -- OCPI reservation flag. NULL = applies regardless of reservation.
  reservation        text,

  created_at         timestamptz    NOT NULL DEFAULT now(),
  updated_at         timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT tariff_restrictions_element_unique UNIQUE (tariff_element_id),

  -- Tightened HH:MM regex (per design call D1 review): only valid wall-clock
  -- times accepted at write. Postgres ARE supports (?:...) non-capturing
  -- groups. Same approach as stations_postal_code_format in 0002 — invalid
  -- value blocked at write, parser logs failure to parser_outcomes (T05).
  CONSTRAINT tariff_restrictions_start_time_format CHECK (
    start_time IS NULL OR start_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
  ),
  CONSTRAINT tariff_restrictions_end_time_format CHECK (
    end_time IS NULL OR end_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'
  ),
  CONSTRAINT tariff_restrictions_date_ordered CHECK (
    start_date IS NULL OR end_date IS NULL OR end_date >= start_date
  ),
  CONSTRAINT tariff_restrictions_kwh_ordered CHECK (
    min_kwh IS NULL OR max_kwh IS NULL OR max_kwh >= min_kwh
  ),
  CONSTRAINT tariff_restrictions_current_ordered CHECK (
    min_current IS NULL OR max_current IS NULL OR max_current >= min_current
  ),
  CONSTRAINT tariff_restrictions_power_ordered CHECK (
    min_power IS NULL OR max_power IS NULL OR max_power >= min_power
  ),
  CONSTRAINT tariff_restrictions_duration_ordered CHECK (
    min_duration IS NULL OR max_duration IS NULL OR max_duration >= min_duration
  ),
  CONSTRAINT tariff_restrictions_kwh_nonneg CHECK (
    (min_kwh IS NULL OR min_kwh >= 0) AND (max_kwh IS NULL OR max_kwh >= 0)
  ),
  CONSTRAINT tariff_restrictions_current_nonneg CHECK (
    (min_current IS NULL OR min_current >= 0) AND (max_current IS NULL OR max_current >= 0)
  ),
  CONSTRAINT tariff_restrictions_power_nonneg CHECK (
    (min_power IS NULL OR min_power >= 0) AND (max_power IS NULL OR max_power >= 0)
  ),
  CONSTRAINT tariff_restrictions_duration_nonneg CHECK (
    (min_duration IS NULL OR min_duration >= 0) AND (max_duration IS NULL OR max_duration >= 0)
  ),
  CONSTRAINT tariff_restrictions_day_of_week_enum CHECK (
    day_of_week IS NULL
    OR day_of_week <@ ARRAY['MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY','SUNDAY']::text[]
  ),
  CONSTRAINT tariff_restrictions_reservation_enum CHECK (
    reservation IS NULL OR reservation IN ('RESERVATION', 'RESERVATION_EXPIRES')
  )
);

CREATE INDEX IF NOT EXISTS tariff_restrictions_element_idx ON live.tariff_restrictions (tariff_element_id);

COMMENT ON TABLE live.tariff_restrictions IS
  'OCPI TariffRestrictions. 0..1 per tariff_element (strict OCPI cardinality, design call (a)). OR-restricted prices = duplicate tariff_elements with shared price_components.';
COMMENT ON COLUMN live.tariff_restrictions.start_time IS
  '"HH:MM" local time. NULL = any time. Overnight windows (e.g. 22:00-06:00) are valid.';
COMMENT ON COLUMN live.tariff_restrictions.day_of_week IS
  'OCPI day-of-week strings. NULL = any day. Array elements must be in {MONDAY..SUNDAY}.';
COMMENT ON COLUMN live.tariff_restrictions.reservation IS
  'OCPI reservation flag: RESERVATION | RESERVATION_EXPIRES. NULL = applies regardless of reservation.';

-- ─────────────────────────────────────────────────────────────────────────
-- updated_at triggers (reuse live.set_updated_at from 0002 — do NOT redefine)
-- ─────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS tariffs_set_updated_at ON live.tariffs;
CREATE TRIGGER tariffs_set_updated_at
  BEFORE UPDATE ON live.tariffs
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();

DROP TRIGGER IF EXISTS tariff_elements_set_updated_at ON live.tariff_elements;
CREATE TRIGGER tariff_elements_set_updated_at
  BEFORE UPDATE ON live.tariff_elements
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();

DROP TRIGGER IF EXISTS price_components_set_updated_at ON live.price_components;
CREATE TRIGGER price_components_set_updated_at
  BEFORE UPDATE ON live.price_components
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();

DROP TRIGGER IF EXISTS tariff_restrictions_set_updated_at ON live.tariff_restrictions;
CREATE TRIGGER tariff_restrictions_set_updated_at
  BEFORE UPDATE ON live.tariff_restrictions
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();
