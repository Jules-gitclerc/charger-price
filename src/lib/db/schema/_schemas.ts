import { pgSchema } from 'drizzle-orm/pg-core';

/**
 * Postgres namespaces used by Prix-Bornes.
 *
 * - `live`    — application data (stations, tariffs, etc.). All migration-
 *               authored tables land here; `public` is reserved for PostGIS
 *               and Supabase-managed objects (see migrations-errata.md E2).
 * - `staging` — per-run scratch space for ingestion (T06+). Truncated/
 *               replaced each run; never queried by the read path.
 * - `archive` — cold storage (≥12-month-old rows, future use).
 *
 * Source: supabase/migrations/0001_extensions.sql.
 */
export const live = pgSchema('live');
export const staging = pgSchema('staging');
export const archive = pgSchema('archive');
