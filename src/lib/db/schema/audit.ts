import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { live } from './_schemas';
import { sources } from './provenance';

/**
 * One row per scheduled job execution. State machine: running →
 * success/failed/partial. T06b writes this row in the same transaction as
 * the diff-and-swap. Source: supabase/migrations/0007_ingestion_audit.sql.
 */
export const ingestionRuns = live.table(
  'ingestion_runs',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    sourceId: uuid('source_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'string' }),
    status: text().default('running').notNull(),
    rowsSeen: integer('rows_seen'),
    rowsInserted: integer('rows_inserted'),
    rowsUpdated: integer('rows_updated'),
    rowsSkipped: integer('rows_skipped'),
    errorMessage: text('error_message'),
    gitSha: text('git_sha'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('ingestion_runs_source_recent_idx').using(
      'btree',
      t.sourceId.asc().nullsLast().op('timestamptz_ops'),
      t.startedAt.desc().nullsFirst().op('timestamptz_ops'),
    ),
    foreignKey({
      columns: [t.sourceId],
      foreignColumns: [sources.id],
      name: 'ingestion_runs_source_id_fkey',
    }),
    check(
      'ingestion_runs_finished_at_ordered',
      sql`(finished_at IS NULL) OR (finished_at >= started_at)`,
    ),
    check(
      'ingestion_runs_finished_at_state_machine',
      sql`((status = 'running'::text) AND (finished_at IS NULL)) OR ((status = ANY (ARRAY['success'::text, 'failed'::text, 'partial'::text])) AND (finished_at IS NOT NULL))`,
    ),
    check(
      'ingestion_runs_rows_inserted_nonneg',
      sql`(rows_inserted IS NULL) OR (rows_inserted >= 0)`,
    ),
    check(
      'ingestion_runs_rows_seen_nonneg',
      sql`(rows_seen IS NULL) OR (rows_seen >= 0)`,
    ),
    check(
      'ingestion_runs_rows_skipped_nonneg',
      sql`(rows_skipped IS NULL) OR (rows_skipped >= 0)`,
    ),
    check(
      'ingestion_runs_rows_updated_nonneg',
      sql`(rows_updated IS NULL) OR (rows_updated >= 0)`,
    ),
    check(
      'ingestion_runs_status_enum',
      sql`status = ANY (ARRAY['running'::text, 'success'::text, 'failed'::text, 'partial'::text])`,
    ),
  ],
);

/**
 * One row per parsed input. Empty in T06 (parsers ship in T09–T13).
 * Source: 0007_ingestion_audit.sql.
 */
export const parserOutcomes = live.table(
  'parser_outcomes',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ingestionRunId: uuid('ingestion_run_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    rawInput: text('raw_input').notNull(),
    rawInputHash: text('raw_input_hash').notNull(),
    outcome: text().notNull(),
    parsedValueJson: jsonb('parsed_value_json'),
    errorMessage: text('error_message'),
    parserVersion: text('parser_version').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('parser_outcomes_hash_idx').using(
      'btree',
      t.rawInputHash.asc().nullsLast().op('text_ops'),
    ),
    index('parser_outcomes_outcome_idx').using(
      'btree',
      t.outcome.asc().nullsLast().op('text_ops'),
    ),
    index('parser_outcomes_run_idx').using(
      'btree',
      t.ingestionRunId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [t.ingestionRunId],
      foreignColumns: [ingestionRuns.id],
      name: 'parser_outcomes_ingestion_run_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.sourceId],
      foreignColumns: [sources.id],
      name: 'parser_outcomes_source_id_fkey',
    }),
    unique('parser_outcomes_dedupe_unique').on(
      t.sourceId,
      t.rawInputHash,
      t.parserVersion,
    ),
    check(
      'parser_outcomes_outcome_enum',
      sql`outcome = ANY (ARRAY['success'::text, 'unknown'::text, 'rejected'::text, 'error'::text])`,
    ),
    check(
      'parser_outcomes_raw_input_hash_format',
      sql`raw_input_hash ~ '^[0-9a-f]{64}$'::text`,
    ),
    check('parser_outcomes_raw_input_length', sql`length(raw_input) <= 65536`),
  ],
);

/**
 * BAN reverse-geocoding cache. Keyed by (address_query, provider). Source:
 * supabase/migrations/0008_geocode_corrections.sql. Populated in T07.
 */
export const geocodeCache = live.table(
  'geocode_cache',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    addressQuery: text('address_query').notNull(),
    normalizedAddress: text('normalized_address'),
    postalCode: text('postal_code'),
    commune: text(),
    codeInsee: text('code_insee'),
    latitude: numeric({ precision: 9, scale: 6 }),
    longitude: numeric({ precision: 9, scale: 6 }),
    confidenceScore: numeric('confidence_score', { precision: 4, scale: 3 }),
    provider: text().default('ban').notNull(),
    cachedAt: timestamp('cached_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('geocode_cache_cached_at_idx').using(
      'btree',
      t.cachedAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('geocode_cache_expires_at_idx')
      .using('btree', t.expiresAt.asc().nullsLast().op('timestamptz_ops'))
      .where(sql`(expires_at IS NOT NULL)`),
    unique('geocode_cache_query_provider_unique').on(t.addressQuery, t.provider),
    check(
      'geocode_cache_confidence_score_range',
      sql`(confidence_score IS NULL) OR ((confidence_score >= (0)::numeric) AND (confidence_score <= (1)::numeric))`,
    ),
    check(
      'geocode_cache_latitude_range',
      sql`(latitude IS NULL) OR ((latitude >= ('-90'::integer)::numeric) AND (latitude <= (90)::numeric))`,
    ),
    check(
      'geocode_cache_longitude_range',
      sql`(longitude IS NULL) OR ((longitude >= ('-180'::integer)::numeric) AND (longitude <= (180)::numeric))`,
    ),
    check(
      'geocode_cache_postal_code_format',
      sql`(postal_code IS NULL) OR (postal_code ~ '^[0-9]{5}$'::text)`,
    ),
    check('geocode_cache_provider_enum', sql`provider = 'ban'::text`),
  ],
);

export type IngestionRun = typeof ingestionRuns.$inferSelect;
export type IngestionRunInsert = typeof ingestionRuns.$inferInsert;
export type ParserOutcome = typeof parserOutcomes.$inferSelect;
export type ParserOutcomeInsert = typeof parserOutcomes.$inferInsert;
export type GeocodeCacheEntry = typeof geocodeCache.$inferSelect;
export type GeocodeCacheEntryInsert = typeof geocodeCache.$inferInsert;
