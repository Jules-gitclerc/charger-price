import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { live } from './_schemas';

/**
 * OCPI Tariff. Source: supabase/migrations/0004_tariffs.sql.
 *
 * `sourceId` references `live.sources(id)`. The FK is defined in the DB but
 * not mirrored here as a Drizzle FK constraint to avoid an import cycle
 * (provenance.ts imports tariffs.ts). The runtime FK is what matters.
 */
export const tariffs = live.table(
  'tariffs',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    slug: text().notNull(),
    displayName: text('display_name').notNull(),
    description: text(),
    tariffType: text('tariff_type').notNull(),
    currency: char({ length: 3 }).default('EUR').notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'string' }),
    validTo: timestamp('valid_to', { withTimezone: true, mode: 'string' }),
    minPriceEur: numeric('min_price_eur', { precision: 10, scale: 4 }),
    maxPriceEur: numeric('max_price_eur', { precision: 10, scale: 4 }),
    taxIncluded: boolean('tax_included'),
    sourceId: uuid('source_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique('tariffs_slug_key').on(t.slug),
    check(
      'tariffs_currency_iso',
      sql`((currency)::text = upper((currency)::text)) AND (length(currency) = 3)`,
    ),
    check(
      'tariffs_max_price_nonneg',
      sql`(max_price_eur IS NULL) OR (max_price_eur >= (0)::numeric)`,
    ),
    check(
      'tariffs_min_price_nonneg',
      sql`(min_price_eur IS NULL) OR (min_price_eur >= (0)::numeric)`,
    ),
    check(
      'tariffs_price_bounds_ordered',
      sql`(min_price_eur IS NULL) OR (max_price_eur IS NULL) OR (max_price_eur >= min_price_eur)`,
    ),
    check(
      'tariffs_slug_lowercase',
      sql`(slug = lower(slug)) AND (slug !~ '\s'::text)`,
    ),
    check(
      'tariffs_type_enum',
      sql`tariff_type = ANY (ARRAY['AD_HOC'::text, 'PROFILE_CHEAP'::text, 'PROFILE_FAST'::text, 'PROFILE_GREEN'::text, 'REGULAR'::text])`,
    ),
    check(
      'tariffs_validity_ordered',
      sql`(valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to > valid_from)`,
    ),
  ],
);

/** Source: 0004_tariffs.sql. */
export const tariffElements = live.table(
  'tariff_elements',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tariffId: uuid('tariff_id').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('tariff_elements_tariff_idx').using(
      'btree',
      t.tariffId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [t.tariffId],
      foreignColumns: [tariffs.id],
      name: 'tariff_elements_tariff_id_fkey',
    }).onDelete('cascade'),
    unique('tariff_elements_tariff_sequence_unique').on(
      t.tariffId,
      t.sequenceNumber,
    ),
    check('tariff_elements_sequence_nonneg', sql`sequence_number >= 0`),
  ],
);

/** Source: 0004_tariffs.sql. */
export const priceComponents = live.table(
  'price_components',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tariffElementId: uuid('tariff_element_id').notNull(),
    type: text().notNull(),
    price: numeric({ precision: 10, scale: 4 }).notNull(),
    vat: numeric({ precision: 5, scale: 2 }),
    stepSize: integer('step_size').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('price_components_element_idx').using(
      'btree',
      t.tariffElementId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [t.tariffElementId],
      foreignColumns: [tariffElements.id],
      name: 'price_components_tariff_element_id_fkey',
    }).onDelete('cascade'),
    check('price_components_price_nonneg', sql`price >= (0)::numeric`),
    check('price_components_step_size_positive', sql`step_size >= 1`),
    check(
      'price_components_type_enum',
      sql`type = ANY (ARRAY['ENERGY'::text, 'TIME'::text, 'FLAT'::text, 'PARKING_TIME'::text])`,
    ),
    check(
      'price_components_vat_nonneg',
      sql`(vat IS NULL) OR (vat >= (0)::numeric)`,
    ),
  ],
);

/** Source: 0004_tariffs.sql. */
export const tariffRestrictions = live.table(
  'tariff_restrictions',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tariffElementId: uuid('tariff_element_id').notNull(),
    startTime: text('start_time'),
    endTime: text('end_time'),
    startDate: date('start_date'),
    endDate: date('end_date'),
    minKwh: numeric('min_kwh', { precision: 10, scale: 2 }),
    maxKwh: numeric('max_kwh', { precision: 10, scale: 2 }),
    minCurrent: numeric('min_current', { precision: 7, scale: 2 }),
    maxCurrent: numeric('max_current', { precision: 7, scale: 2 }),
    minPower: numeric('min_power', { precision: 7, scale: 2 }),
    maxPower: numeric('max_power', { precision: 7, scale: 2 }),
    minDuration: integer('min_duration'),
    maxDuration: integer('max_duration'),
    dayOfWeek: text('day_of_week').array(),
    reservation: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('tariff_restrictions_element_idx').using(
      'btree',
      t.tariffElementId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [t.tariffElementId],
      foreignColumns: [tariffElements.id],
      name: 'tariff_restrictions_tariff_element_id_fkey',
    }).onDelete('cascade'),
    unique('tariff_restrictions_element_unique').on(t.tariffElementId),
    check(
      'tariff_restrictions_current_nonneg',
      sql`((min_current IS NULL) OR (min_current >= (0)::numeric)) AND ((max_current IS NULL) OR (max_current >= (0)::numeric))`,
    ),
    check(
      'tariff_restrictions_current_ordered',
      sql`(min_current IS NULL) OR (max_current IS NULL) OR (max_current >= min_current)`,
    ),
    check(
      'tariff_restrictions_date_ordered',
      sql`(start_date IS NULL) OR (end_date IS NULL) OR (end_date >= start_date)`,
    ),
    check(
      'tariff_restrictions_day_of_week_enum',
      sql`(day_of_week IS NULL) OR (day_of_week <@ ARRAY['MONDAY'::text, 'TUESDAY'::text, 'WEDNESDAY'::text, 'THURSDAY'::text, 'FRIDAY'::text, 'SATURDAY'::text, 'SUNDAY'::text])`,
    ),
    check(
      'tariff_restrictions_duration_nonneg',
      sql`((min_duration IS NULL) OR (min_duration >= 0)) AND ((max_duration IS NULL) OR (max_duration >= 0))`,
    ),
    check(
      'tariff_restrictions_duration_ordered',
      sql`(min_duration IS NULL) OR (max_duration IS NULL) OR (max_duration >= min_duration)`,
    ),
    check(
      'tariff_restrictions_end_time_format',
      sql`(end_time IS NULL) OR (end_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'::text)`,
    ),
    check(
      'tariff_restrictions_kwh_nonneg',
      sql`((min_kwh IS NULL) OR (min_kwh >= (0)::numeric)) AND ((max_kwh IS NULL) OR (max_kwh >= (0)::numeric))`,
    ),
    check(
      'tariff_restrictions_kwh_ordered',
      sql`(min_kwh IS NULL) OR (max_kwh IS NULL) OR (max_kwh >= min_kwh)`,
    ),
    check(
      'tariff_restrictions_power_nonneg',
      sql`((min_power IS NULL) OR (min_power >= (0)::numeric)) AND ((max_power IS NULL) OR (max_power >= (0)::numeric))`,
    ),
    check(
      'tariff_restrictions_power_ordered',
      sql`(min_power IS NULL) OR (max_power IS NULL) OR (max_power >= min_power)`,
    ),
    check(
      'tariff_restrictions_reservation_enum',
      sql`(reservation IS NULL) OR (reservation = ANY (ARRAY['RESERVATION'::text, 'RESERVATION_EXPIRES'::text]))`,
    ),
    check(
      'tariff_restrictions_start_time_format',
      sql`(start_time IS NULL) OR (start_time ~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'::text)`,
    ),
  ],
);

export type Tariff = typeof tariffs.$inferSelect;
export type TariffInsert = typeof tariffs.$inferInsert;
export type TariffElement = typeof tariffElements.$inferSelect;
export type TariffElementInsert = typeof tariffElements.$inferInsert;
export type PriceComponent = typeof priceComponents.$inferSelect;
export type PriceComponentInsert = typeof priceComponents.$inferInsert;
export type TariffRestriction = typeof tariffRestrictions.$inferSelect;
export type TariffRestrictionInsert = typeof tariffRestrictions.$inferInsert;
