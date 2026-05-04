// /internal/station/[id] — full station detail.
// Server Component. notFound() for invalid IDs.

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getStationDetail } from '@/lib/db/queries';
import { TariffSummary } from '@/lib/ui/TariffSummary';

export const dynamic = 'force-dynamic';

export default async function StationDetailPage({
  params,
}: {
  // Next 16: params is a Promise. Must await.
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const station = await getStationDetail(decodeURIComponent(id));
  if (!station) notFound();

  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="mb-4">
        <Link
          href="/internal/search"
          className="text-sm text-zinc-500 hover:underline"
        >
          ← retour à la recherche
        </Link>
      </div>

      <StationHeader station={station} />

      <section className="mt-8">
        <h2 className="mb-4 text-lg font-semibold text-zinc-900">
          Tarifs ({station.tariffs.length})
        </h2>
        {station.tariffs.length === 0 ? (
          <NoTariffs station={station} />
        ) : (
          <div className="space-y-4">
            {station.tariffs.map((t) => (
              <TariffSummary key={t.station_tariff_id} tariff={t} />
            ))}
          </div>
        )}
      </section>

      <QualiteSection station={station} />
    </main>
  );
}

function StationHeader({
  station,
}: {
  station: NonNullable<Awaited<ReturnType<typeof getStationDetail>>>;
}) {
  const operatorLabel =
    station.operator_display_name ?? station.nom_enseigne ?? '—';
  const operatorIsFallback =
    station.operator_display_name === null && station.nom_enseigne !== null;

  return (
    <header className="rounded-lg border border-zinc-200 bg-white p-5">
      <h1 className="text-2xl font-semibold text-zinc-900">
        {station.nom_station}
      </h1>
      <div className="mt-1 text-[11px] font-mono text-zinc-400">
        {station.id_station_itinerance}
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase text-zinc-500">Opérateur</dt>
          <dd className="text-zinc-900">
            {operatorLabel}
            {operatorIsFallback && (
              <span
                title="operator_id NULL — fallback nom_enseigne (E23 long-tail)"
                className="ml-2 text-[10px] uppercase text-amber-700"
              >
                (enseigne brute)
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-zinc-500">Puissance max</dt>
          <dd className="text-zinc-900 tabular-nums">
            {station.max_power_kw !== null
              ? `${station.max_power_kw} kW (sur ${station.pdc_count} PDC)`
              : '—'}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs uppercase text-zinc-500">Adresse</dt>
          <dd className="text-zinc-900">
            {station.adresse_station ?? '—'}
            <div className="text-zinc-600">
              {station.consolidated_code_postal ?? ''}{' '}
              {station.consolidated_commune ?? ''}
            </div>
          </dd>
        </div>
      </dl>
    </header>
  );
}

function NoTariffs({
  station,
}: {
  station: NonNullable<Awaited<ReturnType<typeof getStationDetail>>>;
}) {
  if (station.tariff_url) {
    let host: string;
    try {
      host = new URL(station.tariff_url).hostname;
    } catch {
      host = station.tariff_url;
    }
    return (
      <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-5">
        <p className="text-sm text-zinc-700">
          Aucun tarif analysé pour cette station. L&apos;opérateur publie ses
          tarifs sur son propre site.
        </p>
        <a
          href={station.tariff_url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex flex-col rounded bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-700"
        >
          <span>Voir tarifs sur site opérateur ↗</span>
          <span className="text-[10px] font-normal text-zinc-300">{host}</span>
        </a>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-dashed border-zinc-300 bg-zinc-50 p-5 text-sm text-zinc-600">
      Tarif inconnu — aucune information n&apos;est disponible pour cette station.
    </div>
  );
}

function QualiteSection({
  station,
}: {
  station: NonNullable<Awaited<ReturnType<typeof getStationDetail>>>;
}) {
  if (station.tariffs.length === 0 && !station.tarification_raw) return null;
  const truncated =
    station.tarification_raw && station.tarification_raw.length > 200
      ? station.tarification_raw.slice(0, 200) + '…'
      : station.tarification_raw;

  return (
    <section className="mt-10 rounded-lg border border-zinc-200 bg-zinc-50/50 p-5">
      <h2 className="mb-3 text-sm font-semibold uppercase text-zinc-600">
        Qualité des données
      </h2>
      <dl className="grid gap-2 text-xs">
        {station.tariffs.length > 0 && (
          <>
            <div className="flex gap-2">
              <dt className="w-32 text-zinc-500">Sources</dt>
              <dd className="font-mono text-zinc-700">
                {Array.from(
                  new Set(station.tariffs.map((t) => t.source_slug)),
                ).join(', ')}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-32 text-zinc-500">Versions parser</dt>
              <dd className="font-mono text-zinc-700">
                {Array.from(
                  new Set(
                    station.tariffs
                      .map((t) => t.parser_version)
                      .filter(Boolean),
                  ),
                ).join(', ') || '—'}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-32 text-zinc-500">Vérifié le</dt>
              <dd className="text-zinc-700">
                {new Date(station.tariffs[0].last_verified_at).toLocaleString(
                  'fr-FR',
                )}
              </dd>
            </div>
          </>
        )}
        {truncated && (
          <div className="mt-2">
            <dt className="mb-1 text-zinc-500">Champ IRVE brut</dt>
            <dd className="rounded bg-white p-2 font-mono text-[11px] text-zinc-700 break-words whitespace-pre-wrap">
              {truncated}
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}
