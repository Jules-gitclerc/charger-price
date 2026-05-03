// One-shot smoke: SELECT zero rows from every mirrored table to prove the
// Drizzle schema definitions match the live Supabase column shapes.
// Throws (non-zero exit) on the first mismatch. Run with:
//   set -a; source .env.local; set +a
//   pnpm tsx scripts/lint/schema-smoke.ts

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import {
  operators,
  networks,
  stations,
  chargePoints,
  paymentMethods,
  passProviders,
  subscriptions,
  passMarkups,
  tariffs,
  tariffElements,
  priceComponents,
  tariffRestrictions,
  sources,
  stationTariffs,
  corrections,
  ingestionRuns,
  parserOutcomes,
  geocodeCache,
  communityReports,
  tariffHistory,
} from '@/lib/db/schema';

const url = process.env.SUPABASE_DB_URL;
if (!url) throw new Error('SUPABASE_DB_URL not set');

const client = postgres(url, { max: 1, prepare: false });
const db = drizzle(client);

const targets = [
  ['operators', operators],
  ['networks', networks],
  ['stations', stations],
  ['charge_points', chargePoints],
  ['payment_methods', paymentMethods],
  ['pass_providers', passProviders],
  ['subscriptions', subscriptions],
  ['pass_markups', passMarkups],
  ['tariffs', tariffs],
  ['tariff_elements', tariffElements],
  ['price_components', priceComponents],
  ['tariff_restrictions', tariffRestrictions],
  ['sources', sources],
  ['station_tariffs', stationTariffs],
  ['corrections', corrections],
  ['ingestion_runs', ingestionRuns],
  ['parser_outcomes', parserOutcomes],
  ['geocode_cache', geocodeCache],
  ['community_reports', communityReports],
  ['tariff_history', tariffHistory],
] as const;

async function main() {
  let failed = 0;
  for (const [name, table] of targets) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await db.select().from(table as any).limit(0);
      console.log(`✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`✗ ${name}: ${(err as Error).message}`);
    }
  }
  await client.end();
  if (failed > 0) {
    console.error(`\n${failed} table(s) failed`);
    process.exit(1);
  }
  console.log(`\nAll ${targets.length} mirrors match live DB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
