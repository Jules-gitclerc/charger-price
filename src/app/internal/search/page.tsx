// /internal/search — postal-code OR enseigne search + results table.
// Server Component, GET form, server-render only (DC-T15-H — no client
// state, browser handles loading via native navigation spinner).

import Link from 'next/link';

import {
  searchStationsByEnseigne,
  searchStationsByPostal,
  type StationSearchResult,
} from '@/lib/db/queries';
import { ConfidenceBadge } from '@/lib/ui/ConfidenceBadge';

export const dynamic = 'force-dynamic';

const POSTAL_RE = /^\d{5}$/;

export default async function SearchPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise. Must await.
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;
  const query = (q ?? '').trim();
  const isPostal = POSTAL_RE.test(query);

  let results: StationSearchResult[] = [];
  if (query) {
    results = isPostal
      ? await searchStationsByPostal(query)
      : await searchStationsByEnseigne(query);
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold text-zinc-900">Recherche</h1>
        <Link href="/internal" className="text-sm text-zinc-500 hover:underline">
          ← retour
        </Link>
      </header>

      <form
        method="GET"
        action="/internal/search"
        className="mb-6 flex flex-wrap gap-2"
      >
        <input
          type="text"
          name="q"
          defaultValue={query}
          placeholder="Code postal (ex. 59290) ou enseigne (ex. LIDL)"
          className="flex-1 min-w-[260px] rounded border border-zinc-300 bg-white px-3 py-2 text-sm focus:border-zinc-500 focus:outline-none"
          autoComplete="off"
        />
        <button
          type="submit"
          className="rounded bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          Chercher
        </button>
      </form>

      {!query ? (
        <p className="text-sm text-zinc-500">
          Saisissez un code postal de 5 chiffres ou un mot d&apos;enseigne.
        </p>
      ) : results.length === 0 ? (
        <EmptyState query={query} isPostal={isPostal} />
      ) : (
        <>
          <p className="mb-3 text-xs text-zinc-500">
            {results.length} résultat{results.length > 1 ? 's' : ''} ·{' '}
            {isPostal
              ? `triés par distance depuis le code postal ${query}`
              : `tri alphabétique par nom de station`}
          </p>
          <ResultsTable results={results} showDistance={isPostal} />
        </>
      )}
    </main>
  );
}

function EmptyState({ query, isPostal }: { query: string; isPostal: boolean }) {
  return (
    <div className="my-12 text-center">
      <p className="text-sm text-zinc-700">
        Aucune borne trouvée pour {isPostal ? 'le code postal' : 'l’enseigne'}{' '}
        <span className="font-mono">{query}</span>.
      </p>
      <p className="mt-3">
        <Link
          href="/internal/search"
          className="text-sm text-zinc-500 hover:underline"
        >
          ← nouvelle recherche
        </Link>
      </p>
    </div>
  );
}

function ResultsTable({
  results,
  showDistance,
}: {
  results: StationSearchResult[];
  showDistance: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 text-left text-xs uppercase text-zinc-500">
          <tr>
            <th className="px-3 py-2 font-medium">Station</th>
            <th className="px-3 py-2 font-medium">Opérateur</th>
            <th className="px-3 py-2 font-medium">Adresse</th>
            <th className="px-3 py-2 font-medium text-right">Puissance</th>
            <th className="px-3 py-2 font-medium">Tarif</th>
            {showDistance && (
              <th className="px-3 py-2 font-medium text-right">Distance</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {results.map((r) => (
            <tr key={r.id_station_itinerance} className="hover:bg-zinc-50">
              <td className="px-3 py-2">
                <Link
                  href={`/internal/station/${encodeURIComponent(r.id_station_itinerance)}`}
                  className="font-medium text-zinc-900 hover:underline"
                >
                  {r.nom_station || r.nom_enseigne || '—'}
                </Link>
                <div className="text-[10px] font-mono text-zinc-400">
                  {r.id_station_itinerance}
                </div>
              </td>
              <td className="px-3 py-2 text-zinc-700">
                {r.operator_display_name ?? (
                  <span title="operator_id NULL — fallback nom_enseigne">
                    {r.nom_enseigne ?? '—'}
                  </span>
                )}
              </td>
              <td className="px-3 py-2 text-zinc-600">
                {r.adresse_station ?? '—'}
                <div className="text-[11px] text-zinc-400">
                  {r.consolidated_code_postal ?? ''} {r.consolidated_commune ?? ''}
                </div>
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-700">
                {r.max_power_kw !== null ? `${r.max_power_kw} kW` : '—'}
              </td>
              <td className="px-3 py-2">
                <TariffCell row={r} />
              </td>
              {showDistance && (
                <td className="px-3 py-2 text-right tabular-nums text-zinc-600">
                  {r.distance_meters !== null
                    ? formatDistance(r.distance_meters)
                    : '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TariffCell({ row }: { row: StationSearchResult }) {
  if (row.best_confidence) {
    return <ConfidenceBadge confidence={row.best_confidence} size="xs" />;
  }
  if (row.has_tariff_url) {
    return (
      <span className="text-[11px] text-zinc-500">
        Voir tarifs sur site opérateur ↗
      </span>
    );
  }
  return <span className="text-[11px] text-zinc-400">Tarif inconnu</span>;
}

function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}
