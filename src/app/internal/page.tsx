// Landing index for the internal viewer. Server Component.
// Lists the 3 routes and shows a one-line freshness status.

import Link from 'next/link';

import { getQualiteCoverage } from '@/lib/db/queries';

export const dynamic = 'force-dynamic';

export default async function InternalIndex() {
  const cov = await getQualiteCoverage();
  return (
    <main className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold text-zinc-900">
        Prix-Bornes — viewer interne
      </h1>
      <p className="mt-1 text-sm text-zinc-600">
        M1 demo. Données IRVE consolidées + pipeline parser P5→P0→P1→P2→P3.
      </p>

      <nav className="mt-8 grid gap-3">
        <Link
          href="/internal/search"
          className="block rounded-lg border border-zinc-200 bg-white p-4 hover:border-zinc-400 hover:bg-zinc-50"
        >
          <div className="font-medium text-zinc-900">→ Recherche</div>
          <div className="text-sm text-zinc-600">
            Code postal (5 chiffres) ou enseigne (texte). 10 résultats max.
          </div>
        </Link>
        <Link
          href="/internal/qualite-des-donnees"
          className="block rounded-lg border border-zinc-200 bg-white p-4 hover:border-zinc-400 hover:bg-zinc-50"
        >
          <div className="font-medium text-zinc-900">
            → Qualité des données
          </div>
          <div className="text-sm text-zinc-600">
            {cov.total_stations.toLocaleString('fr-FR')} stations,{' '}
            {cov.with_station_tariffs.toLocaleString('fr-FR')} avec tarif
            analysé.
          </div>
        </Link>
      </nav>

      <p className="mt-8 text-xs text-zinc-500">
        Dernier sync IRVE :{' '}
        {cov.last_irve_sync_at
          ? new Date(cov.last_irve_sync_at).toLocaleString('fr-FR')
          : 'jamais'}{' '}
        · Dernier run parser :{' '}
        {cov.last_parser_run_at
          ? new Date(cov.last_parser_run_at).toLocaleString('fr-FR')
          : 'jamais'}
      </p>
    </main>
  );
}
