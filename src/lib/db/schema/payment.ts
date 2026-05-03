import { sql } from 'drizzle-orm';
import {
  char,
  check,
  foreignKey,
  index,
  numeric,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { live } from './_schemas';
import { operators, networks } from './identity';

/**
 * Payment method lookup (cb_ad_hoc / operator_app / operator_subscription /
 * roaming_pass). Source: supabase/migrations/0003_payment_methods.sql.
 */
export const paymentMethods = live.table(
  'payment_methods',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    slug: text().notNull(),
    displayName: text('display_name').notNull(),
    kind: text().notNull(),
    description: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('payment_methods_slug_key').on(t.slug),
    check(
      'payment_methods_kind_enum',
      sql`kind = ANY (ARRAY['cb_ad_hoc'::text, 'operator_app'::text, 'operator_subscription'::text, 'roaming_pass'::text])`,
    ),
    check(
      'payment_methods_slug_lowercase',
      sql`(slug = lower(slug)) AND (slug !~ '\s'::text)`,
    ),
  ],
);

/**
 * Roaming pass provider (Chargemap, Shell Recharge, Plugsurfing, KiWhi/Fulli).
 * Source: 0003_payment_methods.sql.
 */
export const passProviders = live.table(
  'pass_providers',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    slug: text().notNull(),
    displayName: text('display_name').notNull(),
    websiteUrl: text('website_url'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('pass_providers_slug_key').on(t.slug),
    check(
      'pass_providers_slug_lowercase',
      sql`(slug = lower(slug)) AND (slug !~ '\s'::text)`,
    ),
  ],
);

/**
 * Recurring plan from either an operator or a pass provider (XOR enforced
 * by the `subscriptions_provider_xor` CHECK). Source: 0003_payment_methods.sql.
 *
 * NOTE: forward declaration of `sources.id` is referenced by FK; the
 * `sourceId` column is mirrored here but the table import is avoided to
 * keep the cycle one-way (provenance.ts imports payment.ts).
 */
export const subscriptions = live.table(
  'subscriptions',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    slug: text().notNull(),
    displayName: text('display_name').notNull(),
    operatorId: uuid('operator_id'),
    passProviderId: uuid('pass_provider_id'),
    monthlyFeeEur: numeric('monthly_fee_eur', { precision: 10, scale: 4 }),
    yearlyFeeEur: numeric('yearly_fee_eur', { precision: 10, scale: 4 }),
    currency: char({ length: 3 }).default('EUR').notNull(),
    sourceId: uuid('source_id').notNull(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('subscriptions_operator_slug_unique')
      .using(
        'btree',
        t.operatorId.asc().nullsLast().op('text_ops'),
        t.slug.asc().nullsLast().op('text_ops'),
      )
      .where(sql`(operator_id IS NOT NULL)`),
    uniqueIndex('subscriptions_pass_provider_slug_unique')
      .using(
        'btree',
        t.passProviderId.asc().nullsLast().op('uuid_ops'),
        t.slug.asc().nullsLast().op('uuid_ops'),
      )
      .where(sql`(pass_provider_id IS NOT NULL)`),
    foreignKey({
      columns: [t.operatorId],
      foreignColumns: [operators.id],
      name: 'subscriptions_operator_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.passProviderId],
      foreignColumns: [passProviders.id],
      name: 'subscriptions_pass_provider_id_fkey',
    }).onDelete('cascade'),
    check(
      'subscriptions_currency_iso',
      sql`(currency)::text = upper((currency)::text)`,
    ),
    check(
      'subscriptions_has_a_fee',
      sql`(monthly_fee_eur IS NOT NULL) OR (yearly_fee_eur IS NOT NULL)`,
    ),
    check(
      'subscriptions_monthly_fee_nonneg',
      sql`(monthly_fee_eur IS NULL) OR (monthly_fee_eur >= (0)::numeric)`,
    ),
    check(
      'subscriptions_provider_xor',
      sql`(((operator_id IS NOT NULL))::integer + ((pass_provider_id IS NOT NULL))::integer) = 1`,
    ),
    check(
      'subscriptions_slug_lowercase',
      sql`(slug = lower(slug)) AND (slug !~ '\s'::text)`,
    ),
    check(
      'subscriptions_yearly_fee_nonneg',
      sql`(yearly_fee_eur IS NULL) OR (yearly_fee_eur >= (0)::numeric)`,
    ),
  ],
);

/**
 * Pass-side multiplier table. One row per (subscription, network) pair.
 * Source: 0003_payment_methods.sql.
 */
export const passMarkups = live.table(
  'pass_markups',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    subscriptionId: uuid('subscription_id').notNull(),
    networkId: uuid('network_id').notNull(),
    multiplierPct: numeric('multiplier_pct', { precision: 6, scale: 2 }),
    flatFeeEur: numeric('flat_fee_eur', { precision: 10, scale: 4 }),
    sourceId: uuid('source_id').notNull(),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('pass_markups_network_idx').using(
      'btree',
      t.networkId.asc().nullsLast().op('uuid_ops'),
    ),
    index('pass_markups_subscription_idx').using(
      'btree',
      t.subscriptionId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [t.networkId],
      foreignColumns: [networks.id],
      name: 'pass_markups_network_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.subscriptionId],
      foreignColumns: [subscriptions.id],
      name: 'pass_markups_subscription_id_fkey',
    }).onDelete('cascade'),
    unique('pass_markups_subscription_network_unique').on(
      t.subscriptionId,
      t.networkId,
    ),
    check(
      'pass_markups_flat_fee_nonneg',
      sql`(flat_fee_eur IS NULL) OR (flat_fee_eur >= (0)::numeric)`,
    ),
    check(
      'pass_markups_has_a_value',
      sql`(multiplier_pct IS NOT NULL) OR (flat_fee_eur IS NOT NULL)`,
    ),
    check(
      'pass_markups_multiplier_range',
      sql`(multiplier_pct IS NULL) OR ((multiplier_pct >= ('-100'::integer)::numeric) AND (multiplier_pct <= (1000)::numeric))`,
    ),
  ],
);

export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type PaymentMethodInsert = typeof paymentMethods.$inferInsert;
export type PassProvider = typeof passProviders.$inferSelect;
export type PassProviderInsert = typeof passProviders.$inferInsert;
export type Subscription = typeof subscriptions.$inferSelect;
export type SubscriptionInsert = typeof subscriptions.$inferInsert;
export type PassMarkup = typeof passMarkups.$inferSelect;
export type PassMarkupInsert = typeof passMarkups.$inferInsert;
