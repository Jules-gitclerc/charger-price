import { customType } from 'drizzle-orm/pg-core';

/**
 * PostGIS `geography(Point, 4326)` column.
 *
 * Drizzle has no first-class PostGIS support, so we declare a custom type
 * that round-trips as raw text in TypeScript. At read time the value is the
 * EWKB hex string Postgres returns for `geography`; at write time, callers
 * must pass an already-formed expression (`ST_SetSRID(ST_MakePoint(lon, lat),
 * 4326)::geography`) via `sql\`...\``, not a string literal.
 *
 * Used by `live.stations.geom` (see supabase/migrations/0002_identity.sql).
 */
export const geographyPoint = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'geography(Point, 4326)';
  },
});
