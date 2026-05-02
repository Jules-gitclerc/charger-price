import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Server-side @supabase/supabase-js client — used for Storage uploads
// (raw HTML scraper snapshots, future) and any operation that talks to
// Supabase's HTTP API surface rather than direct Postgres.
//
// The data plane (stations, tariffs, etc.) goes through Drizzle in
// src/lib/db/index.ts — NOT through this client. This file exists so that
// when we need Storage in M1.5+ the client is ready.
//
// Service-role key is server-only — NEVER importable from a Client Component.
// If absent we fall back to the publishable key (read-only HTTP).

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL is not set. See .env.example.');
}

const key = serviceRoleKey ?? publishableKey;
if (!key) {
  throw new Error(
    'Neither SUPABASE_SERVICE_ROLE_KEY nor NEXT_PUBLIC_SUPABASE_ANON_KEY is set. See .env.example.',
  );
}

export const supabaseServer: SupabaseClient = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Explicit signal for callers that need elevated writes:
export const hasServiceRole = Boolean(serviceRoleKey);
