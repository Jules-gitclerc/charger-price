import { type VercelConfig } from '@vercel/config/v1';

// Vercel project configuration in TypeScript (replaces vercel.json).
// See https://vercel.com/docs/project-configuration/vercel-ts
//
// Scope: minimal for T01. Cron jobs for per-operator scrapers (T14 / M1.5)
// and any rewrites/headers will be added here. The IRVE daily ingestion runs
// in GitHub Actions, NOT here — see docs/02-architecture.md §2.1 and the
// upcoming docs/cron-inventory.md for the split rationale.

export const config: VercelConfig = {
  framework: 'nextjs',
  // All Functions pinned to Paris region (closest to French users + Supabase eu-west-3).
  regions: ['cdg1'],
};

export default config;
