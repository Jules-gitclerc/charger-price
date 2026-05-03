import { sql } from 'drizzle-orm';
import { check, index, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { live } from './_schemas';

/**
 * Append-only price-history snapshots. The table is `PARTITION BY RANGE
 * (snapshot_at)`; concrete partitions (`tariff_history_YYYY_MM`) are
 * created in supabase/migrations/0006_tariff_history.sql and rolled
 * forward by .github/workflows/partition-rollover.yml.
 *
 * App code talks to the parent — Postgres routes inserts to the right
 * leaf. Drizzle has no first-class partition modeling so we mirror only
 * the parent shape; partitions are an SQL concern.
 *
 * Composite PK is `(id, snapshot_at)` because Postgres requires the
 * partition key in the PK on partitioned tables.
 *
 * NOT touched by T06 (T06 does not write `station_tariffs`, so no
 * UPDATE trigger fires into history).
 */
export const tariffHistory = live.table(
  'tariff_history',
  {
    id: uuid().defaultRandom().notNull(),
    stationTariffId: uuid('station_tariff_id').notNull(),
    stationId: text('station_id').notNull(),
    paymentMethodId: uuid('payment_method_id').notNull(),
    subscriptionId: uuid('subscription_id'),
    tariffId: uuid('tariff_id'),
    confidence: text().notNull(),
    sourceId: uuid('source_id').notNull(),
    parserVersion: text('parser_version'),
    lastVerifiedAt: timestamp('last_verified_at', {
      withTimezone: true,
      mode: 'string',
    }).notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' }),
    snapshotAt: timestamp('snapshot_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    changeKind: text('change_kind').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.snapshotAt], name: 'tariff_history_pkey' }),
    index('tariff_history_station_tariff_id_snapshot_at_idx').using(
      'btree',
      t.stationTariffId.asc().nullsLast().op('timestamptz_ops'),
      t.snapshotAt.desc().nullsFirst().op('timestamptz_ops'),
    ),
    check(
      'tariff_history_change_kind_enum',
      sql`change_kind = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text])`,
    ),
    check(
      'tariff_history_confidence_enum',
      sql`confidence = ANY (ARRAY['verified'::text, 'parsed'::text, 'estimated'::text, 'unknown'::text])`,
    ),
  ],
);

export type TariffHistoryEntry = typeof tariffHistory.$inferSelect;
export type TariffHistoryEntryInsert = typeof tariffHistory.$inferInsert;
