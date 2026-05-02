-- Migration 0003 — Payment methods + pass providers + subscriptions + pass markups
--
-- T04, M1 W2.
--
-- WHY HAND-ROLLED SQL (not Drizzle-Kit generated):
--   Multi-column CHECK constraints (XOR provider, fee shape, multiplier
--   sanity range, has-a-value), partial UNIQUE indexes (operator-side vs
--   pass-side subscription slug uniqueness), the deferred FK pattern for
--   source_id, and the cross-table trigger validating that pass_markups
--   only attach to pass-provider-side subscriptions are all clearer in
--   raw SQL than in a Drizzle migration generator. We also reuse
--   live.set_updated_at() from 0002 without redefining it.
--
-- IDEMPOTENCY: every CREATE uses IF NOT EXISTS. Triggers use DROP IF EXISTS
-- + CREATE. Functions use CREATE OR REPLACE. INSERT … ON CONFLICT (slug)
-- DO NOTHING for the payment_methods seed rows so re-applying never
-- duplicates them.
--
-- ENTITIES (per docs/02-architecture.md §1.2 + T04 brief):
--   payment_methods — lookup of payment "shapes" (cb_ad_hoc / operator_app
--                     / operator_subscription / roaming_pass). Slug-based.
--                     Seeded with 10 starter rows so live.operators
--                     .default_payment_methods (text[] of slugs from
--                     migration 0002) has a populated lookup target.
--   pass_providers  — the company behind a roaming pass (Chargemap, Shell
--                     Recharge, Plugsurfing, KiWhi/Fulli). NOT seeded —
--                     populated by application / scrapers as they come
--                     online (T14+).
--   subscriptions   — a specific paid plan. Belongs to EITHER an operator
--                     (Electra+ Boost, Ionity Passport, Fastned Gold) OR
--                     a pass provider (Chargemap Premium). XOR enforced
--                     by CHECK. monthly_fee_eur powers the amortized-cost
--                     toggle (Phase 1 Q5).
--   pass_markups    — pass × network markup grid. Per discrepancy #2:
--                     carries source_id + last_verified_at provenance,
--                     NO confidence enum, NO parser_version. Pass markup
--                     grids are commercial data published by the pass
--                     providers themselves — current or stale, not
--                     "estimated." Application flags >30-day-old rows
--                     stale at the API layer. Subscription-kind invariant
--                     (pass-side only) enforced by trigger, not deferred
--                     to the API layer.
--
-- ASYMMETRIC PROVENANCE (per T04 session brief discrepancy #2 ruling):
--   subscriptions  → source_id + last_verified_at. No confidence.
--   pass_markups   → source_id + last_verified_at. No confidence.
--   tariffs (0004) → source_id only. No last_verified_at, no confidence.
--   station_tariffs (0005) → full 4-col confidence machinery (source_id,
--                            confidence, last_verified_at, parser_version).
--
-- DEFERRED FK + DEFERRED NOT NULL (per T04 brief correction C1):
--   live.sources is created in migration 0005. To keep 0003 standalone-
--   applicable against the 0001+0002 prefix AND to avoid the structural
--   lie of a NOT NULL column referencing a non-existent table, source_id
--   columns here are declared `uuid` (nullable, no FK). Migration 0005
--   then runs:
--     -- After live.sources exists and is seeded (incl. a 'manual_seed'
--     -- row at priority 1000 / kind 'correction' for backfill safety):
--     UPDATE live.subscriptions
--        SET source_id = (SELECT id FROM live.sources WHERE slug = 'manual_seed')
--      WHERE source_id IS NULL;
--     UPDATE live.pass_markups
--        SET source_id = (SELECT id FROM live.sources WHERE slug = 'manual_seed')
--      WHERE source_id IS NULL;
--
--     ALTER TABLE live.subscriptions ALTER COLUMN source_id SET NOT NULL;
--     ALTER TABLE live.subscriptions
--       ADD CONSTRAINT subscriptions_source_id_fkey
--       FOREIGN KEY (source_id) REFERENCES live.sources(id);
--
--     ALTER TABLE live.pass_markups  ALTER COLUMN source_id SET NOT NULL;
--     ALTER TABLE live.pass_markups
--       ADD CONSTRAINT pass_markups_source_id_fkey
--       FOREIGN KEY (source_id) REFERENCES live.sources(id);
--
--   In normal flow no rows are inserted between 0003 and 0005, so the
--   backfill UPDATEs are no-ops. They exist as insurance against a partial
--   apply or out-of-order seed script.

-- ─────────────────────────────────────────────────────────────────────────
-- payment_methods (lookup)
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.payment_methods (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text         NOT NULL UNIQUE,
  display_name  text         NOT NULL,
  -- kind is the OCPI-adjacent category. station_tariffs (0005) joins via
  -- payment_method_id; the API derives the OCPI Tariff `type` from this
  -- column rather than storing it separately.
  kind          text         NOT NULL,
  description   text,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT payment_methods_slug_lowercase CHECK (slug = lower(slug) AND slug !~ '\s'),
  CONSTRAINT payment_methods_kind_enum CHECK (
    kind IN ('cb_ad_hoc', 'operator_app', 'operator_subscription', 'roaming_pass')
  )
);

COMMENT ON TABLE live.payment_methods IS
  'Lookup of payment shapes. Slug-based. operators.default_payment_methods (text[]) references slugs here.';
COMMENT ON COLUMN live.payment_methods.kind IS
  'OCPI-adjacent category: cb_ad_hoc | operator_app | operator_subscription | roaming_pass.';

-- Seed: 10 starter payment methods. Required so operators.default_payment_methods
-- has valid lookup targets. ON CONFLICT (slug) DO NOTHING keeps re-apply safe.
INSERT INTO live.payment_methods (slug, display_name, kind, description) VALUES
  ('cb-direct',             'Carte bancaire (sans abonnement)',  'cb_ad_hoc',             'Paiement direct par carte bancaire au terminal de la borne, sans identification ni abonnement.'),
  ('operator-subscription', 'Abonnement opérateur (générique)',   'operator_subscription', 'Catégorie générique pour les abonnements opérateurs sans plan spécifique référencé.'),
  ('tesla-app',             'Application Tesla',                  'operator_app',          'Tarif dynamique visible uniquement dans l''app Tesla. Non scrappé en M1.'),
  ('electra-start',         'Electra Start (sans abonnement)',    'cb_ad_hoc',             'Tarif standard Electra payé à l''acte via app ou CB. Pas d''abonnement requis.'),
  ('electra-boost',         'Electra+ Boost',                     'operator_subscription', 'Abonnement Electra+ Boost (€9.99/mois) — réduction sur le €/kWh Electra.'),
  ('ionity-passport',       'Ionity Passport',                    'operator_subscription', 'Abonnement Ionity Passport (Power 365 / Motion 365) — €/kWh réduit.'),
  ('chargemap-pass',        'Chargemap Pass',                     'roaming_pass',          'Pass d''itinérance Chargemap. Markup variable selon CPO (voir pass_markups).'),
  ('shell-recharge',        'Shell Recharge',                     'roaming_pass',          'Pass Shell Recharge. Markup par CPO.'),
  ('plugsurfing',           'Plugsurfing',                        'roaming_pass',          'Pass Plugsurfing. Frais de service ~10 % par session.'),
  ('kiwhi-pass',            'KiWhi Pass / Fulli',                 'roaming_pass',          'Pass KiWhi (devenu Fulli). Markup par CPO.')
ON CONFLICT (slug) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- pass_providers
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.pass_providers (
  id            uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          text         NOT NULL UNIQUE,
  display_name  text         NOT NULL,
  website_url   text,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT pass_providers_slug_lowercase CHECK (slug = lower(slug) AND slug !~ '\s')
);

COMMENT ON TABLE live.pass_providers IS
  'Roaming pass company (Chargemap, Shell Recharge, Plugsurfing, KiWhi/Fulli). Populated by application/scrapers, not seeded here.';

-- ─────────────────────────────────────────────────────────────────────────
-- subscriptions
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.subscriptions (
  id                 uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text         NOT NULL,
  display_name       text         NOT NULL,

  -- XOR: a subscription is owned by EITHER an operator (Electra+ Boost,
  -- Ionity Passport, Fastned Gold) OR a pass provider (Chargemap Premium).
  -- Never both, never neither.
  operator_id        uuid         REFERENCES live.operators(id)      ON DELETE CASCADE,
  pass_provider_id   uuid         REFERENCES live.pass_providers(id) ON DELETE CASCADE,

  monthly_fee_eur    numeric(10,4),
  yearly_fee_eur     numeric(10,4),
  currency           char(3)      NOT NULL DEFAULT 'EUR',

  -- Provenance (no confidence / parser_version here per discrepancy #2).
  -- source_id is nullable in 0003; 0005 backfills, sets NOT NULL, adds FK.
  source_id          uuid,
  last_verified_at   timestamptz  NOT NULL DEFAULT now(),

  created_at         timestamptz  NOT NULL DEFAULT now(),
  updated_at         timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT subscriptions_slug_lowercase CHECK (slug = lower(slug) AND slug !~ '\s'),
  CONSTRAINT subscriptions_provider_xor CHECK (
    ((operator_id IS NOT NULL)::int + (pass_provider_id IS NOT NULL)::int) = 1
  ),
  CONSTRAINT subscriptions_currency_iso CHECK (currency = upper(currency)),
  CONSTRAINT subscriptions_monthly_fee_nonneg CHECK (monthly_fee_eur IS NULL OR monthly_fee_eur >= 0),
  CONSTRAINT subscriptions_yearly_fee_nonneg  CHECK (yearly_fee_eur  IS NULL OR yearly_fee_eur  >= 0),
  -- A subscription with neither monthly nor yearly fee is meaningless: a
  -- "free tier" is the absence of a subscription, not a subscription row.
  CONSTRAINT subscriptions_has_a_fee CHECK (
    monthly_fee_eur IS NOT NULL OR yearly_fee_eur IS NOT NULL
  )
);

-- Slug uniqueness scoped to the owning entity. Partial unique indexes
-- because UNIQUE (operator_id, slug) treats NULLs as distinct, which
-- would allow many (NULL, 'boost') rows on the pass-provider side.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_operator_slug_unique
  ON live.subscriptions (operator_id, slug)
  WHERE operator_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_pass_provider_slug_unique
  ON live.subscriptions (pass_provider_id, slug)
  WHERE pass_provider_id IS NOT NULL;

COMMENT ON TABLE live.subscriptions IS
  'A specific paid plan (operator-side or pass-provider-side). XOR enforced. monthly_fee_eur powers the amortized-cost toggle (Phase 1 Q5).';
COMMENT ON COLUMN live.subscriptions.source_id IS
  'Nullable in 0003. Migration 0005 creates live.sources, backfills any pre-existing rows to the manual_seed source, sets NOT NULL, then adds the FK.';

-- ─────────────────────────────────────────────────────────────────────────
-- pass_markups
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS live.pass_markups (
  id                 uuid           PRIMARY KEY DEFAULT gen_random_uuid(),

  -- A markup is tied to a SUBSCRIPTION (not just to a pass provider) —
  -- different tiers of the same pass may have different markups
  -- (e.g. Chargemap free vs Premium). Subscription-kind invariant
  -- (pass-provider-side only) enforced by the
  -- pass_markups_subscription_kind_check trigger below.
  subscription_id    uuid           NOT NULL REFERENCES live.subscriptions(id) ON DELETE CASCADE,

  -- Network granularity (sub-operator) per docs/02-architecture.md §1.2.
  network_id         uuid           NOT NULL REFERENCES live.networks(id)      ON DELETE CASCADE,

  -- Markup shape: percentage on top of CPO base + optional flat per-session
  -- fee. Both nullable individually, but at least one must be set —
  -- per correction C2: a passthrough relationship (no markup) is the
  -- absence of a row, not a row with both fields null. multiplier_pct
  -- of -100 = full subsidy (free for the user).
  multiplier_pct     numeric(6,2),
  flat_fee_eur       numeric(10,4),

  -- Provenance. Same nullable→NOT-NULL plan as subscriptions.source_id.
  source_id          uuid,
  last_verified_at   timestamptz    NOT NULL DEFAULT now(),

  created_at         timestamptz    NOT NULL DEFAULT now(),
  updated_at         timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT pass_markups_subscription_network_unique UNIQUE (subscription_id, network_id),
  CONSTRAINT pass_markups_multiplier_range CHECK (
    multiplier_pct IS NULL OR (multiplier_pct >= -100 AND multiplier_pct <= 1000)
  ),
  CONSTRAINT pass_markups_flat_fee_nonneg CHECK (flat_fee_eur IS NULL OR flat_fee_eur >= 0),
  CONSTRAINT pass_markups_has_a_value CHECK (
    multiplier_pct IS NOT NULL OR flat_fee_eur IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS pass_markups_network_idx       ON live.pass_markups (network_id);
CREATE INDEX IF NOT EXISTS pass_markups_subscription_idx  ON live.pass_markups (subscription_id);

COMMENT ON TABLE live.pass_markups IS
  'Pass × network markup grid. One row per (subscription, network). Provenance via source_id + last_verified_at; no confidence enum (commercial data is current-or-stale, not estimated). Passthrough = absence of row.';
COMMENT ON COLUMN live.pass_markups.multiplier_pct IS
  'Percentage on top of the CPO base price (e.g. 15.00 = +15 %, -100 = free, 0 = explicit zero markup). Nullable iff flat_fee_eur is set.';
COMMENT ON COLUMN live.pass_markups.flat_fee_eur IS
  'Flat per-session service fee. Nullable iff multiplier_pct is set.';
COMMENT ON COLUMN live.pass_markups.source_id IS
  'Nullable in 0003. Migration 0005 backfills, sets NOT NULL, adds FK to live.sources.';

-- ─────────────────────────────────────────────────────────────────────────
-- Cross-table invariant: pass_markups.subscription_id must point to a
-- pass-provider-side subscription. Enforced via trigger because Postgres
-- has no native compound FK that can encode this. Per correction C3:
-- DB invariants belong in the DB, not deferred to the API layer.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION live.check_pass_markup_subscription()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_pass_side boolean;
BEGIN
  SELECT (pass_provider_id IS NOT NULL)
    INTO is_pass_side
    FROM live.subscriptions
    WHERE id = NEW.subscription_id;

  IF is_pass_side IS NULL THEN
    -- subscription_id missing — let the FK constraint produce the error
    -- with its standard message. (FK fires after this trigger anyway,
    -- but be explicit.)
    RETURN NEW;
  END IF;

  IF NOT is_pass_side THEN
    RAISE EXCEPTION
      'pass_markups.subscription_id must reference a pass-provider-side subscription, got operator-side subscription %',
      NEW.subscription_id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pass_markups_subscription_kind_check ON live.pass_markups;
CREATE TRIGGER pass_markups_subscription_kind_check
  BEFORE INSERT OR UPDATE OF subscription_id ON live.pass_markups
  FOR EACH ROW EXECUTE FUNCTION live.check_pass_markup_subscription();

-- ─────────────────────────────────────────────────────────────────────────
-- updated_at triggers (reuse live.set_updated_at from 0002 — do NOT redefine)
-- ─────────────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS payment_methods_set_updated_at ON live.payment_methods;
CREATE TRIGGER payment_methods_set_updated_at
  BEFORE UPDATE ON live.payment_methods
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();

DROP TRIGGER IF EXISTS pass_providers_set_updated_at ON live.pass_providers;
CREATE TRIGGER pass_providers_set_updated_at
  BEFORE UPDATE ON live.pass_providers
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();

DROP TRIGGER IF EXISTS subscriptions_set_updated_at ON live.subscriptions;
CREATE TRIGGER subscriptions_set_updated_at
  BEFORE UPDATE ON live.subscriptions
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();

DROP TRIGGER IF EXISTS pass_markups_set_updated_at ON live.pass_markups;
CREATE TRIGGER pass_markups_set_updated_at
  BEFORE UPDATE ON live.pass_markups
  FOR EACH ROW EXECUTE FUNCTION live.set_updated_at();
