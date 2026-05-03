-- Migration 0008 — geocode_cache + corrections
--
-- T05, M1 W2.
--
-- WHY HAND-ROLLED SQL (not Drizzle-Kit generated):
--   Coordinate range CHECKs, postal code format CHECK (mirroring 0002's
--   stations_postal_code_format), email format CHECK, the
--   corrections_applied_requires_tariff invariant CHECK, and the partial
--   UNIQUE INDEX with COALESCE(...) on the applied-correction natural
--   key are clearer in raw SQL. Reuses live.set_updated_at() from 0002.
--
-- IDEMPOTENCY: every CREATE uses IF NOT EXISTS. Triggers use DROP IF
-- EXISTS + CREATE.
--
-- ENTITIES (per docs/02-architecture.md §1.2 + §A3 + T05 brief):
--   geocode_cache  — BAN reverse-geocode results cached by
--                    (address_query, provider). T07 backfill (W3) hits
--                    the BAN API for the 95k IRVE rows missing
--                    consolidated_code_postal; results land here.
--                    Eviction is application-driven via expires_at.
--   corrections    — operator-submitted price corrections per
--                    docs/02-architecture.md §A3. Powers the
--                    corrections@ mailbox workflow. Status enum drives
--                    a moderation queue. When status='applied', the
--                    application UPSERTs a station_tariffs row with
--                    source='operator_correction' (priority 0 — wins).
--
-- DESIGN CALLS (per T05 brief §0008 review):
--
-- D1 — geocode_cache.provider as text + CHECK enum:
--   provider IN ('ban') for M1. Per Phase 1 ruling: BAN API only, no
--   Google Maps. CHECK forces explicit migration when adding a future
--   fallback provider — silent provider drift is exactly the kind of
--   bug that bites at 2am.
--
-- D2 — expires_at semantics:
--   Nullable. NULL = "never expires" (high-confidence rural addresses).
--   Application sets the value at insert (default 90 days; T07 will
--   document the convention in docs/integrations/ban.md). No CHECK on
--   expires_at > cached_at — a row with expires_at < cached_at is
--   immediately stale, not corrupt; eviction handles it.
--
-- D3 — submitted_by_email format CHECK:
--   Trivial regex `^[^@]+@[^@]+\.[^@]+$`. Catches typos and accidental
--   empty strings; doesn't pretend to be RFC-5322 compliant.
--   Cloudflare Email Routing (corrections@prix-bornes.fr → forwarded
--   inbox, per Day-1 step 4 of docs/03-implementation-plan.md) handles
--   real validation downstream.
--
-- D4 — corrections invariant: applied requires tariff:
--   CHECK: NOT (status='applied' AND corrected_tariff_id IS NULL).
--   Until we ship the "delete existing station_tariffs row" workflow,
--   an applied correction MUST point to a tariff. Pending and rejected
--   rows can have a NULL corrected_tariff_id (i.e. someone reported "no
--   tariff here"); they just can't be marked applied with that shape.
--   The whole point of the corrections table is enforce trust at the DB
--   layer (per T04 hard rule #5 spirit).
--
-- D5 — Index overlap with 0010:
--   The moderation-queue partial index `corrections (status,
--   submitted_at DESC) WHERE status='pending'` lives HERE in 0008
--   (single source of truth), NOT in 0010. Same pattern as 0007's
--   parser_outcomes_hash_idx. 0010 header will note the dropped
--   reference to avoid future "wait why isn't this in 0010" confusion.
--
-- D6 — corrections station-pair uniqueness:
--   Multiple PENDING corrections per (station, payment_method,
--   subscription) are allowed — different operators may submit
--   conflicting reports; the moderator sees them all and decides.
--   At most one APPLIED correction per natural key at a time —
--   partial UNIQUE INDEX WHERE status='applied' enforces.

-- ─────────────────────────────────────────────────────────────────────────
-- geocode_cache
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.geocode_cache (
  id                  uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  address_query       text           NOT NULL,
  normalized_address  text,
  postal_code         text,
  commune             text,
  code_insee          text,
  latitude            numeric(9,6),
  longitude           numeric(9,6),
  -- 0..1 inclusive. BAN returns scores like 0.957; we keep 3 decimals.
  confidence_score    numeric(4,3),
  -- D1: provider enum CHECK. 'ban' is the only valid value in M1.
  -- Future provider additions require an explicit migration relaxing
  -- this CHECK.
  provider            text           NOT NULL DEFAULT 'ban',
  cached_at           timestamptz    NOT NULL DEFAULT now(),
  -- D2: nullable. NULL = never expires. Application sets at insert.
  expires_at          timestamptz,
  created_at          timestamptz    NOT NULL DEFAULT now(),
  updated_at          timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT geocode_cache_provider_enum CHECK (provider IN ('ban')),
  CONSTRAINT geocode_cache_postal_code_format CHECK (
    postal_code IS NULL OR postal_code ~ '^[0-9]{5}$'
  ),
  CONSTRAINT geocode_cache_latitude_range CHECK (
    latitude IS NULL OR (latitude >= -90 AND latitude <= 90)
  ),
  CONSTRAINT geocode_cache_longitude_range CHECK (
    longitude IS NULL OR (longitude >= -180 AND longitude <= 180)
  ),
  CONSTRAINT geocode_cache_confidence_score_range CHECK (
    confidence_score IS NULL OR (confidence_score >= 0 AND confidence_score <= 1)
  ),
  CONSTRAINT geocode_cache_query_provider_unique UNIQUE (address_query, provider)
);

-- Eviction by age (rare; mostly we filter on expires_at) and by
-- expiry. Both indexes are cheap on an empty table.
CREATE INDEX IF NOT EXISTS geocode_cache_cached_at_idx  ON live.geocode_cache (cached_at);
CREATE INDEX IF NOT EXISTS geocode_cache_expires_at_idx ON live.geocode_cache (expires_at) WHERE expires_at IS NOT NULL;

COMMENT ON TABLE live.geocode_cache IS
  'BAN reverse-geocode result cache. Keyed on (address_query, provider). T07 (W3) backfill populates this for the 95k IRVE rows missing postal code.';
COMMENT ON COLUMN live.geocode_cache.provider IS
  'Geocoding provider. Currently restricted to ''ban'' by CHECK. Future provider additions require a migration relaxing the CHECK — no silent drift.';
COMMENT ON COLUMN live.geocode_cache.expires_at IS
  'NULL = never expires. Application convention: 90 days for typical addresses; NULL for high-confidence rural addresses.';
COMMENT ON COLUMN live.geocode_cache.confidence_score IS
  'BAN-supplied score in [0, 1]. Application uses it to decide whether to trust the geocode or request human review.';

DROP TRIGGER IF EXISTS geocode_cache_set_updated_at ON live.geocode_cache;
CREATE TRIGGER geocode_cache_set_updated_at
  BEFORE UPDATE ON live.geocode_cache
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();

-- ─────────────────────────────────────────────────────────────────────────
-- corrections
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.corrections (
  id                       uuid           PRIMARY KEY DEFAULT gen_random_uuid(),

  station_id               text           NOT NULL REFERENCES live.stations(id_station_itinerance) ON DELETE CASCADE,
  payment_method_id        uuid           NOT NULL REFERENCES live.payment_methods(id),
  subscription_id          uuid                    REFERENCES live.subscriptions(id) ON DELETE SET NULL,
  -- NULL = "no tariff applies here" (an operator reporting we should
  -- delete the existing station_tariffs row). Constrained by the
  -- corrections_applied_requires_tariff CHECK below.
  corrected_tariff_id      uuid                    REFERENCES live.tariffs(id) ON DELETE SET NULL,

  submitted_by_email       text           NOT NULL,
  submitted_at             timestamptz    NOT NULL DEFAULT now(),
  justification            text           NOT NULL,

  verified_by_operator_at  timestamptz,
  applied_at               timestamptz,
  status                   text           NOT NULL DEFAULT 'pending',

  created_at               timestamptz    NOT NULL DEFAULT now(),
  updated_at               timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT corrections_status_enum CHECK (
    status IN ('pending', 'applied', 'rejected')
  ),
  -- D3: trivial email format. Defends against typos and empty strings;
  -- not RFC-5322 compliant.
  CONSTRAINT corrections_email_format CHECK (
    submitted_by_email ~ '^[^@]+@[^@]+\.[^@]+$'
  ),
  -- D4: applied requires a non-NULL tariff (until we ship the
  -- "delete the existing station_tariffs row" workflow).
  CONSTRAINT corrections_applied_requires_tariff CHECK (
    NOT (status = 'applied' AND corrected_tariff_id IS NULL)
  )
);

-- Index pair for the moderation page (D5 — overlap with 0010 resolved
-- here): list pending corrections newest-first.
CREATE INDEX IF NOT EXISTS corrections_status_idx     ON live.corrections (status);
CREATE INDEX IF NOT EXISTS corrections_station_idx    ON live.corrections (station_id);
CREATE INDEX IF NOT EXISTS corrections_pending_queue_idx
  ON live.corrections (submitted_at DESC)
  WHERE status = 'pending';

-- D6: at most one APPLIED correction per (station, payment_method,
-- subscription) at any moment. PENDING and REJECTED rows are
-- unconstrained — different operators may legitimately submit
-- conflicting reports; the moderator sees them all.
CREATE UNIQUE INDEX IF NOT EXISTS corrections_applied_unique
  ON live.corrections (
    station_id,
    payment_method_id,
    COALESCE(subscription_id, '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE status = 'applied';

COMMENT ON TABLE live.corrections IS
  'Operator-submitted price corrections per docs/02-architecture.md §A3. Status enum drives a moderation queue. Applied rows feed station_tariffs via source=operator_correction (priority 0).';
COMMENT ON COLUMN live.corrections.corrected_tariff_id IS
  'NULL = "no tariff applies here" (delete request). Pending/rejected rows can carry NULL; applied rows MUST have a tariff (CHECK enforced) until the deletion workflow ships.';
COMMENT ON COLUMN live.corrections.status IS
  'pending | applied | rejected. The active correction at any (station, payment_method, subscription) is the unique one with status=applied.';
COMMENT ON COLUMN live.corrections.justification IS
  'Operator-supplied free-text rationale. Surfaces in the moderator UI.';

DROP TRIGGER IF EXISTS corrections_set_updated_at ON live.corrections;
CREATE TRIGGER corrections_set_updated_at
  BEFORE UPDATE ON live.corrections
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();
