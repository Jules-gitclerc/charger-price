import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  numeric,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { live } from './_schemas';
import { stations } from './identity';
import { paymentMethods } from './payment';

/**
 * Community-submitted price observations. Schema-only in M1 (no UI surface
 * until M3). Source: supabase/migrations/0009_community_reports.sql.
 */
export const communityReports = live.table(
  'community_reports',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    stationId: text('station_id').notNull(),
    paymentMethodId: uuid('payment_method_id').notNull(),
    reportedBySessionId: text('reported_by_session_id').notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    reportedPriceEur: numeric('reported_price_eur', { precision: 10, scale: 4 }),
    reportedKwh: numeric('reported_kwh', { precision: 10, scale: 3 }),
    reportedSessionTotalEur: numeric('reported_session_total_eur', {
      precision: 10,
      scale: 4,
    }),
    comment: text(),
    status: text().default('pending').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('community_reports_pending_queue_idx')
      .using('btree', t.reportedAt.desc().nullsFirst().op('timestamptz_ops'))
      .where(sql`(status = 'pending'::text)`),
    index('community_reports_reported_at_idx').using(
      'btree',
      t.reportedAt.desc().nullsFirst().op('timestamptz_ops'),
    ),
    index('community_reports_station_idx').using(
      'btree',
      t.stationId.asc().nullsLast().op('text_ops'),
    ),
    index('community_reports_status_idx').using(
      'btree',
      t.status.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [t.paymentMethodId],
      foreignColumns: [paymentMethods.id],
      name: 'community_reports_payment_method_id_fkey',
    }),
    foreignKey({
      columns: [t.stationId],
      foreignColumns: [stations.idStationItinerance],
      name: 'community_reports_station_id_fkey',
    }).onDelete('cascade'),
    check(
      'community_reports_comment_length',
      sql`(comment IS NULL) OR (length(comment) <= 4096)`,
    ),
    check(
      'community_reports_has_a_value',
      sql`(reported_price_eur IS NOT NULL) OR (reported_session_total_eur IS NOT NULL)`,
    ),
    check(
      'community_reports_kwh_nonneg',
      sql`(reported_kwh IS NULL) OR (reported_kwh >= (0)::numeric)`,
    ),
    check(
      'community_reports_price_nonneg',
      sql`(reported_price_eur IS NULL) OR (reported_price_eur >= (0)::numeric)`,
    ),
    check(
      'community_reports_session_id_length',
      sql`(length(reported_by_session_id) > 0) AND (length(reported_by_session_id) <= 128)`,
    ),
    check(
      'community_reports_session_total_nonneg',
      sql`(reported_session_total_eur IS NULL) OR (reported_session_total_eur >= (0)::numeric)`,
    ),
    check(
      'community_reports_status_enum',
      sql`status = ANY (ARRAY['pending'::text, 'reviewed'::text, 'incorporated'::text, 'rejected'::text])`,
    ),
  ],
);

export type CommunityReport = typeof communityReports.$inferSelect;
export type CommunityReportInsert = typeof communityReports.$inferInsert;
