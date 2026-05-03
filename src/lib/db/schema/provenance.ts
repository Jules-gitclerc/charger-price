import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { live } from './_schemas';
import { stations } from './identity';
import { paymentMethods, subscriptions } from './payment';
import { tariffs } from './tariffs';

/**
 * Registry of every upstream data source. Source: supabase/migrations/
 * 0005_provenance.sql. T06b reads this to find the `irve_consolidated`
 * row when stamping `ingestion_runs.source_id`.
 */
export const sources = live.table(
  'sources',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    slug: text().notNull(),
    displayName: text('display_name').notNull(),
    kind: text().notNull(),
    priority: integer().notNull(),
    description: text(),
    websiteUrl: text('website_url'),
    isEnabled: boolean('is_enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('sources_slug_key').on(t.slug),
    check(
      'sources_kind_enum',
      sql`kind = ANY (ARRAY['dataset'::text, 'parser'::text, 'scraper'::text, 'correction'::text])`,
    ),
    check('sources_priority_nonneg', sql`priority >= 0`),
    check(
      'sources_slug_lowercase',
      sql`(slug = lower(slug)) AND (slug !~ '\s'::text)`,
    ),
  ],
);

/**
 * The confidence-bearing join from a station to its applicable tariff.
 * One row per (station_id, payment_method_id, source_id, valid_from).
 * Source: 0005_provenance.sql.
 *
 * NOTE for T06: this table is OFF-LIMITS. T06 does not write tariff data.
 * The first writer is T13 (parser pipeline) for `parsed`/`unknown` rows
 * and T14 (Fastned scraper) for `verified` rows.
 */
export const stationTariffs = live.table(
  'station_tariffs',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    stationId: text('station_id').notNull(),
    paymentMethodId: uuid('payment_method_id').notNull(),
    subscriptionId: uuid('subscription_id'),
    tariffId: uuid('tariff_id'),
    confidence: text().notNull(),
    sourceId: uuid('source_id').notNull(),
    parserVersion: text('parser_version'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('station_tariffs_active_idx')
      .using(
        'btree',
        t.stationId.asc().nullsLast().op('text_ops'),
        t.paymentMethodId.asc().nullsLast().op('uuid_ops'),
      )
      .where(sql`(valid_to IS NULL)`),
    uniqueIndex('station_tariffs_active_unique')
      .using(
        'btree',
        sql`station_id`,
        sql`payment_method_id`,
        sql`COALESCE(subscription_id, '00000000-0000-0000-0000-000000000000')`,
      )
      .where(sql`(valid_to IS NULL)`),
    index('station_tariffs_confidence_idx').using(
      'btree',
      t.confidence.asc().nullsLast().op('text_ops'),
    ),
    index('station_tariffs_payment_active_idx')
      .using(
        'btree',
        t.paymentMethodId.asc().nullsLast().op('text_ops'),
        t.stationId.asc().nullsLast().op('uuid_ops'),
      )
      .where(sql`(valid_to IS NULL)`),
    index('station_tariffs_payment_method_idx').using(
      'btree',
      t.paymentMethodId.asc().nullsLast().op('uuid_ops'),
    ),
    index('station_tariffs_station_idx').using(
      'btree',
      t.stationId.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [t.paymentMethodId],
      foreignColumns: [paymentMethods.id],
      name: 'station_tariffs_payment_method_id_fkey',
    }),
    foreignKey({
      columns: [t.sourceId],
      foreignColumns: [sources.id],
      name: 'station_tariffs_source_id_fkey',
    }),
    foreignKey({
      columns: [t.stationId],
      foreignColumns: [stations.idStationItinerance],
      name: 'station_tariffs_station_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.subscriptionId],
      foreignColumns: [subscriptions.id],
      name: 'station_tariffs_subscription_id_fkey',
    }).onDelete('set null'),
    foreignKey({
      columns: [t.tariffId],
      foreignColumns: [tariffs.id],
      name: 'station_tariffs_tariff_id_fkey',
    }).onDelete('set null'),
    check(
      'station_tariffs_confidence_enum',
      sql`confidence = ANY (ARRAY['verified'::text, 'parsed'::text, 'estimated'::text, 'unknown'::text])`,
    ),
    check(
      'station_tariffs_unknown_implies_no_tariff',
      sql`(confidence = 'unknown'::text) = (tariff_id IS NULL)`,
    ),
    check(
      'station_tariffs_validity_ordered',
      sql`(valid_to IS NULL) OR (valid_to > valid_from)`,
    ),
  ],
);

/**
 * Operator-side correction queue. Source: supabase/migrations/
 * 0008_geocode_corrections.sql.
 */
export const corrections = live.table(
  'corrections',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    stationId: text('station_id').notNull(),
    paymentMethodId: uuid('payment_method_id').notNull(),
    subscriptionId: uuid('subscription_id'),
    correctedTariffId: uuid('corrected_tariff_id'),
    submittedByEmail: text('submitted_by_email').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    justification: text().notNull(),
    verifiedByOperatorAt: timestamp('verified_by_operator_at', {
      withTimezone: true,
      mode: 'string',
    }),
    appliedAt: timestamp('applied_at', { withTimezone: true, mode: 'string' }),
    status: text().default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('corrections_applied_unique')
      .using(
        'btree',
        sql`station_id`,
        sql`payment_method_id`,
        sql`COALESCE(subscription_id, '00000000-0000-0000-0000-000000000000')`,
      )
      .where(sql`(status = 'applied'::text)`),
    index('corrections_pending_queue_idx')
      .using('btree', t.submittedAt.desc().nullsFirst().op('timestamptz_ops'))
      .where(sql`(status = 'pending'::text)`),
    index('corrections_station_idx').using(
      'btree',
      t.stationId.asc().nullsLast().op('text_ops'),
    ),
    index('corrections_status_idx').using(
      'btree',
      t.status.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [t.correctedTariffId],
      foreignColumns: [tariffs.id],
      name: 'corrections_corrected_tariff_id_fkey',
    }).onDelete('set null'),
    foreignKey({
      columns: [t.paymentMethodId],
      foreignColumns: [paymentMethods.id],
      name: 'corrections_payment_method_id_fkey',
    }),
    foreignKey({
      columns: [t.stationId],
      foreignColumns: [stations.idStationItinerance],
      name: 'corrections_station_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.subscriptionId],
      foreignColumns: [subscriptions.id],
      name: 'corrections_subscription_id_fkey',
    }).onDelete('set null'),
    check(
      'corrections_applied_requires_tariff',
      sql`NOT ((status = 'applied'::text) AND (corrected_tariff_id IS NULL))`,
    ),
    check(
      'corrections_email_format',
      sql`submitted_by_email ~ '^[^@]+@[^@]+\.[^@]+$'::text`,
    ),
    check(
      'corrections_status_enum',
      sql`status = ANY (ARRAY['pending'::text, 'applied'::text, 'rejected'::text])`,
    ),
  ],
);

export type Source = typeof sources.$inferSelect;
export type SourceInsert = typeof sources.$inferInsert;
export type StationTariff = typeof stationTariffs.$inferSelect;
export type StationTariffInsert = typeof stationTariffs.$inferInsert;
export type Correction = typeof corrections.$inferSelect;
export type CorrectionInsert = typeof corrections.$inferInsert;
