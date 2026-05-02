import { defineConfig } from 'drizzle-kit';

// Drizzle config — used by `pnpm drizzle-kit *` commands.
// Schema definitions live under src/lib/db/schema/ (added in T04, W2).
// Generated SQL migrations land under supabase/migrations/ alongside the
// hand-written ones (see docs/03-implementation-plan.md §2).
//
// schemaFilter limits introspection to namespaces we own. The supabase_*
// system schemas (auth, storage, realtime, vault, etc.) are excluded — they
// belong to Supabase, not to us.

export default defineConfig({
  schema: './src/lib/db/schema/*.ts',
  out: './supabase/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.SUPABASE_DB_URL ?? '',
  },
  schemaFilter: ['public', 'live', 'staging', 'archive'],
  verbose: true,
  strict: true,
});
