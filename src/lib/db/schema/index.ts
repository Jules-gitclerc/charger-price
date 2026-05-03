/**
 * Drizzle schema mirrors of the live Supabase database.
 *
 * Hand-curated from `drizzle-kit introspect` output (T06 prerequisite).
 * Source migrations: supabase/migrations/0001..0010_*.sql.
 *
 * Conventions:
 *   - One file per logical domain. Tables are exported as bare names
 *     (`stations`, not `stationsInLive`); the schema namespace is on the
 *     `live`/`staging`/`archive` constants in `_schemas.ts`.
 *   - Each table mirror has a JSDoc reference to its source migration.
 *   - PostGIS `geography` is mirrored via `customType` in `postgis.ts`.
 *   - Partitioned `live.tariff_history` is mirrored as the parent only;
 *     monthly partitions are an SQL concern (0006 + partition-rollover.yml).
 *   - Excluded from mirrors: PostGIS system tables (`spatial_ref_sys`,
 *     `geography_columns`, `geometry_columns`) — not application data.
 */

export * from './_schemas';
export * from './postgis';
export * from './identity';
export * from './payment';
export * from './tariffs';
export * from './provenance';
export * from './audit';
export * from './community';
export * from './history';
