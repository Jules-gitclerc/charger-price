-- Migration 0002 — Identity tables
--
-- T04, M1 W2.
--
-- WHY HAND-ROLLED SQL (not Drizzle-Kit generated):
--   PostGIS `geography(Point, 4326)` columns and GIST indexes have no
--   first-class Drizzle DSL representation. The expression-rich CHECK
--   constraints below (slug shape, ISO country code, postal-code format)
--   are also clearer in raw SQL than in a Drizzle migration generator.
--   The shared updated_at trigger function (live.set_updated_at) is plpgsql
--   and reused by 0003/0004/0005 — defined here once.
--
-- IDEMPOTENCY: every CREATE uses IF NOT EXISTS. Triggers use DROP IF EXISTS
-- + CREATE so re-applying the migration cleanly replaces them.
--
-- ENTITIES (per docs/02-architecture.md §1.2):
--   operators     — canonical brand (resolves the "LIDL"/"Lidl France",
--                   "Tesla"/"TESLA SUPERCHARGER" duplicates from Phase 1 A.1).
--                   T08 (W3) populates operator_aliases and starts assigning
--                   stations.operator_id; until then operator_id is nullable.
--   networks      — sub-network within an operator (e.g. "TotalEnergies
--                   Charge Rapide" inside operator "TotalEnergies").
--   stations      — physical site. PK = id_station_itinerance per Phase 1 Q9
--                   (national ID as PK, geometry as resolver). 42% of IRVE
--                   rows have no postal code; T07 (W3) reverse-geocodes them.
--   charge_points — one connector. PK = id_pdc_itinerance.
--
-- T05 NOTE: the trigger added in migration 0006 to populate tariff_history
-- reads station_id off station_tariffs (created in 0005), which in turn FKs
-- live.stations.id_station_itinerance — defined here. No change needed in
-- this file for T05; this is a reminder that the chain holds.

-- ─────────────────────────────────────────────────────────────────────────
-- operators
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.operators (
  id                       uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  slug                     text           NOT NULL UNIQUE,
  display_name             text           NOT NULL,
  country                  char(2)        NOT NULL DEFAULT 'FR',
  website_url              text,
  logo_url                 text,
  -- Default payment methods, by slug. Stored as text[] (no FK to payment_methods
  -- — no FK-on-array support in Postgres). Application validates against the
  -- payment_methods lookup table (created in migration 0003).
  default_payment_methods  text[]         NOT NULL DEFAULT ARRAY[]::text[],
  created_at               timestamptz    NOT NULL DEFAULT now(),
  updated_at               timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT operators_slug_lowercase  CHECK (slug = lower(slug) AND slug !~ '\s'),
  CONSTRAINT operators_country_iso3166 CHECK (country = upper(country))
);

COMMENT ON TABLE  live.operators IS
  'Canonical operator brand. Resolves duplicate enseigne entries from IRVE (Phase 1 A.1). One row per real-world brand.';
COMMENT ON COLUMN live.operators.slug IS
  'Lowercase, no-whitespace identifier (e.g. ''power-dot'', ''tesla-supercharger'').';
COMMENT ON COLUMN live.operators.default_payment_methods IS
  'Slugs of payment methods (no FK — Postgres has no FK-on-array). Application validates against live.payment_methods (migration 0003).';

-- ─────────────────────────────────────────────────────────────────────────
-- networks
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.networks (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id   uuid         NOT NULL REFERENCES live.operators(id) ON DELETE CASCADE,
  slug          text         NOT NULL,
  display_name  text         NOT NULL,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT networks_slug_lowercase  CHECK (slug = lower(slug) AND slug !~ '\s'),
  CONSTRAINT networks_operator_slug_unique UNIQUE (operator_id, slug)
);

COMMENT ON TABLE live.networks IS
  'Sub-network within an operator (distinct tariff regime). Optional — many operators have only one network.';

-- ─────────────────────────────────────────────────────────────────────────
-- stations
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.stations (
  -- Primary key is the IRVE national station ID per Phase 1 Q9.
  id_station_itinerance      text                        PRIMARY KEY,

  -- Resolution to canonical brand. Nullable until T08 (W3) runs the
  -- operator_aliases mapping and populates this column.
  operator_id                uuid                        REFERENCES live.operators(id) ON DELETE SET NULL,
  network_id                 uuid                        REFERENCES live.networks(id)  ON DELETE SET NULL,

  -- IRVE-side identity & display
  id_station_local           text,
  nom_station                text                        NOT NULL,
  -- nom_enseigne is nullable: a missing enseigne is reality, not error.
  -- UI displays "Enseigne non communiquée" — same transparency pillar
  -- as the confidence enum on station_tariffs.
  nom_enseigne               text,

  -- Address (raw + consolidated). The consolidated_* fields are filled by
  -- the IRVE consolidator OR by our T07 BAN reverse-geocode for the 42%
  -- of rows missing postal code upstream.
  adresse_station            text,
  code_insee_commune         text,
  consolidated_code_postal   text,
  consolidated_commune       text,

  -- Geometry. WGS84 lon/lat, geography (not geometry) so ST_DWithin uses
  -- meters out of the box without a projection cast.
  geom                       geography(Point, 4326)      NOT NULL,

  -- IRVE descriptive fields kept verbatim for the read API.
  implantation_station       text,
  condition_acces            text,
  horaires                   text,
  reservation                boolean,
  accessibilite_pmr          text,
  restriction_gabarit        text,
  station_deux_roues         boolean,
  raccordement               text,
  num_pdl                    text,
  date_mise_en_service       date,
  observations               text,

  -- Tariff URL extracted by P3 (parser, T13 — W5). Populated outside this
  -- migration; column declared here so the parser pipeline can UPDATE.
  tariff_url                 text,

  -- Freshness / lifecycle
  date_maj                   date,                       -- IRVE last-update field
  last_seen_in_irve_at       timestamptz,                -- bumped on each IRVE sync where the row appears
  first_seen_at              timestamptz                 NOT NULL DEFAULT now(),
  created_at                 timestamptz                 NOT NULL DEFAULT now(),
  updated_at                 timestamptz                 NOT NULL DEFAULT now(),

  -- Postal code format. Reject malformed values at write; T07 (W3) logs
  -- failures to parser_outcomes (created in migration 0007 / T05) rather
  -- than writing a corrupt postal code.
  CONSTRAINT stations_postal_code_format CHECK (
    consolidated_code_postal IS NULL
    OR consolidated_code_postal ~ '^[0-9]{5}$'
  )
);

-- GIST spatial index for ST_DWithin (the "stations within 10 km" query that
-- powers the user-facing search per docs/03-implementation-plan.md §4.2).
-- Plan §2 lists this in 0002 (with the table) AND in 0010 (with all
-- indexes). Resolved here — placing it with the column it indexes is
-- conventional, and 0010 is for indexes that must wait until after the
-- initial 224k-row import to avoid double-write cost. A spatial index is
-- cheap on an empty table and we want it before any insert.
CREATE INDEX IF NOT EXISTS stations_geom_gist ON live.stations USING GIST (geom);

COMMENT ON TABLE  live.stations IS
  'Physical station site. PK = IRVE id_station_itinerance per Phase 1 Q9.';
COMMENT ON COLUMN live.stations.geom IS
  'WGS84 lon/lat as PostGIS geography. Use ST_DWithin in meters.';
COMMENT ON COLUMN live.stations.tariff_url IS
  'URL extracted from the IRVE tarification field by parser P3 (T13). Source-of-tariff link, not a price.';

-- ─────────────────────────────────────────────────────────────────────────
-- charge_points
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.charge_points (
  id_pdc_itinerance     text          PRIMARY KEY,
  station_id            text          NOT NULL REFERENCES live.stations(id_station_itinerance) ON DELETE CASCADE,
  id_pdc_local          text,

  -- Power & physical
  power_kw              numeric(7,2)  NOT NULL,           -- IRVE puissance_nominale, kW
  cable_t2_attache      boolean,

  -- Sockets (IRVE booleans, kept verbatim — many true-false combos)
  prise_type_ef         boolean,
  prise_type_2          boolean,
  prise_type_combo_ccs  boolean,
  prise_type_chademo    boolean,
  prise_type_autre      boolean,

  -- Payment availability (IRVE booleans). NOT the tariff itself — that
  -- lives in station_tariffs (migration 0005). These three are just
  -- "what means of payment does the hardware support."
  paiement_acte         boolean,
  paiement_cb           boolean,
  paiement_autre        boolean,
  gratuit               boolean,

  -- IRVE descriptive
  observations          text,

  -- Freshness / lifecycle
  last_seen_in_irve_at  timestamptz,
  first_seen_at         timestamptz   NOT NULL DEFAULT now(),
  created_at            timestamptz   NOT NULL DEFAULT now(),
  updated_at            timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT charge_points_power_positive CHECK (power_kw > 0)
);

CREATE INDEX IF NOT EXISTS charge_points_station_idx ON live.charge_points (station_id);

COMMENT ON TABLE  live.charge_points IS
  'Individual connector. One row per IRVE id_pdc_itinerance.';
COMMENT ON COLUMN live.charge_points.power_kw IS
  'Nominal power in kW. Positive. Used for power-tier tariff matching.';

-- ─────────────────────────────────────────────────────────────────────────
-- updated_at maintenance (shared across all live.* tables)
-- Function defined here, reused by 0003/0004/0005 — do NOT redefine.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION live.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operators_set_updated_at ON live.operators;
CREATE TRIGGER operators_set_updated_at
  BEFORE UPDATE ON live.operators
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();

DROP TRIGGER IF EXISTS networks_set_updated_at ON live.networks;
CREATE TRIGGER networks_set_updated_at
  BEFORE UPDATE ON live.networks
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();

DROP TRIGGER IF EXISTS stations_set_updated_at ON live.stations;
CREATE TRIGGER stations_set_updated_at
  BEFORE UPDATE ON live.stations
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();

DROP TRIGGER IF EXISTS charge_points_set_updated_at ON live.charge_points;
CREATE TRIGGER charge_points_set_updated_at
  BEFORE UPDATE ON live.charge_points
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();
