import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

// Server-side Drizzle client — the elevated-privileges path for ingestion,
// scrapers, parsers, and admin reads. Connects via the direct Postgres URL
// (NOT the transaction pooler) so it can handle COPY operations needed by
// the IRVE pipeline (T06a, W2).
//
// Usage:
//   import { db } from '@/lib/db';
//   const rows = await db.select().from(...);
//
// Read-only client (`dbReadOnly`) is exported separately so a future read
// replica or pgbouncer instance can be swapped in without touching call sites.
// In M1 they share the same connection; the split is structural insurance,
// not a current optimization.
//
// LAZY INIT (W5 Vercel deploy fix): Next 16's "Collect page data" build phase
// evaluates page modules to gather config/metadata, which transitively loads
// this file. A top-level throw on missing SUPABASE_DB_URL crashed the build
// even when the route was marked `dynamic = 'force-dynamic'` (route was never
// going to run at build, but the module still gets loaded). Deferring the
// throw + the postgres() handshake into a Proxy getter keeps module-load
// side-effect-free; the error fires only at first query, when the request
// actually needs the connection.

let cached: ReturnType<typeof drizzle> | null = null;

function getClient() {
  if (cached) return cached;

  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    throw new Error(
      'SUPABASE_DB_URL is not set. Copy from Supabase dashboard → Settings → Database → Connection string → URI (transaction pooler OK for app reads; direct connection required for COPY in T06a). See .env.example.',
    );
  }

  // Single postgres-js client; Drizzle wraps it. `max: 1` keeps connection count
  // low for serverless functions (Vercel Functions reuse instances under Fluid
  // Compute, but each cold start opens a fresh socket).
  const sql = postgres(connectionString, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false, // Required for Supabase transaction pooler compatibility.
  });
  cached = drizzle(sql);
  return cached;
}

// Proxy lazily forwards every property access to the real Drizzle client.
// First access triggers getClient() which validates env + opens the socket;
// subsequent accesses hit the cached instance.
export const db = new Proxy({} as ReturnType<typeof drizzle>, {
  get(_target, prop, receiver) {
    const real = getClient();
    return Reflect.get(real, prop, receiver);
  },
});

export const dbReadOnly = db; // Aliased in M1; will diverge when read replica lands.
