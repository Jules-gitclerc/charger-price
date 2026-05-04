// /internal/qualite-des-donnees — coverage dashboard.
// Server Component. Pure aggregations from getQualiteCoverage().

import Link from 'next/link';

import {
  type Confidence,
  type CoverageStats,
  getQualiteCoverage,
} from '@/lib/db/queries';
import { ConfidenceBadge } from '@/lib/ui/ConfidenceBadge';

export const dynamic = 'force-dynamic';

const CONFIDENCE_ORDER: Confidence[] = [
  'verified',
  'parsed',
  'estimated',
  'unknown',
];

export default async function QualiteDesDonneesPage() {
  const cov = await getQualiteCoverage();
  const totalParserOutcomes = cov.by_parser_source.reduce(
    (s, r) => s + r.count,
    0,
  );
  const stationsWithoutTariff =
    cov.total_stations - cov.with_station_tariffs;

  return (
    <main className="mx-auto max-w-5xl p-6">
      <header className="mb-6 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">
            Qualité des données
          </h1>
          <p className="mt-1 text-sm text-zinc-600">
            Source IRVE consolidée + pipeline parser P5→P0→P1→P2→P3 (M1).
          </p>
        </div>
        <Link href="/internal" className="text-sm text-zinc-500 hover:underline">
          ← retour
        </Link>
      </header>

      <section className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="Stations totales"
          value={cov.total_stations}
          pct={null}
        />
        <StatCard
          label="Avec opérateur"
          value={cov.with_operator_id}
          pct={pct(cov.with_operator_id, cov.total_stations)}
        />
        <StatCard
          label="Avec code postal"
          value={cov.with_postal_code}
          pct={pct(cov.with_postal_code, cov.total_stations)}
        />
        <StatCard
          label="Avec tarif analysé"
          value={cov.with_station_tariffs}
          pct={pct(cov.with_station_tariffs, cov.total_stations)}
          highlight
        />
        <StatCard
          label="Avec URL tarifs"
          value={cov.with_tariff_url}
          pct={pct(cov.with_tariff_url, cov.total_stations)}
        />
      </section>

      <section className="mb-8 grid gap-6 lg:grid-cols-2">
        <ConfidenceTable cov={cov} />
        <ParserSourceTable
          rows={cov.by_parser_source}
          total={totalParserOutcomes}
        />
      </section>

      <section className="mb-8 rounded-lg border border-amber-200 bg-amber-50 p-5">
        <h2 className="mb-2 text-sm font-semibold text-amber-900">
          Couverture M1 — état honnête
        </h2>
        <ul className="space-y-1 text-sm text-amber-900">
          <li>
            <strong>{stationsWithoutTariff.toLocaleString('fr-FR')}</strong>{' '}
            stations ({pct(stationsWithoutTariff, cov.total_stations)}) sans
            tarif analysé — pas de hit parser ou sentinel-only.
          </li>
          <li>
            <strong>
              {(
                cov.total_stations - cov.with_operator_id
              ).toLocaleString('fr-FR')}
            </strong>{' '}
            stations (
            {pct(
              cov.total_stations - cov.with_operator_id,
              cov.total_stations,
            )}
            ) sans opérateur résolu (E23 long-tail). Le viewer affiche le{' '}
            <code className="text-xs">nom_enseigne</code> brut en fallback.
          </li>
          <li>
            Tier <code>verified</code> : 0 lignes (en attente du scraper
            Fastned, T14).
          </li>
        </ul>
      </section>

      <section className="text-xs text-zinc-500">
        <div>
          Dernier sync IRVE :{' '}
          <span className="font-mono">
            {cov.last_irve_sync_at
              ? new Date(cov.last_irve_sync_at).toLocaleString('fr-FR')
              : 'jamais'}
          </span>
        </div>
        <div>
          Dernier run orchestrator parser :{' '}
          <span className="font-mono">
            {cov.last_parser_run_at
              ? new Date(cov.last_parser_run_at).toLocaleString('fr-FR')
              : 'jamais'}
          </span>
        </div>
      </section>
    </main>
  );
}

function StatCard({
  label,
  value,
  pct,
  highlight,
}: {
  label: string;
  value: number;
  pct: string | null;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        highlight
          ? 'border-amber-200 bg-amber-50'
          : 'border-zinc-200 bg-white'
      }`}
    >
      <div className="text-xs uppercase text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">
        {value.toLocaleString('fr-FR')}
      </div>
      {pct !== null && (
        <div className="text-xs text-zinc-600">{pct}</div>
      )}
    </div>
  );
}

function ConfidenceTable({ cov }: { cov: CoverageStats }) {
  const totalActiveTariffs = CONFIDENCE_ORDER.reduce(
    (s, k) => s + cov.by_confidence[k],
    0,
  );
  return (
    <div className="rounded-lg border border-zinc-200 bg-white">
      <h3 className="border-b border-zinc-200 px-4 py-3 text-sm font-semibold text-zinc-900">
        Confidence tier breakdown
      </h3>
      <table className="w-full text-sm">
        <tbody className="divide-y divide-zinc-100">
          {CONFIDENCE_ORDER.map((k) => (
            <tr key={k}>
              <td className="px-4 py-2">
                <ConfidenceBadge confidence={k} />
              </td>
              <td className="px-4 py-2 text-right tabular-nums text-zinc-900">
                {cov.by_confidence[k].toLocaleString('fr-FR')}
              </td>
              <td className="px-4 py-2 text-right text-xs text-zinc-500 tabular-nums w-16">
                {pct(cov.by_confidence[k], totalActiveTariffs) ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ParserSourceTable({
  rows,
  total,
}: {
  rows: CoverageStats['by_parser_source'];
  total: number;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white">
      <h3 className="border-b border-zinc-200 px-4 py-3 text-sm font-semibold text-zinc-900">
        Parser source × outcome (input-grain)
      </h3>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase text-zinc-500">
          <tr>
            <th className="px-4 py-2 font-medium">Source</th>
            <th className="px-4 py-2 font-medium">Outcome</th>
            <th className="px-4 py-2 text-right font-medium">Count</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((r) => (
            <tr key={`${r.source_slug}-${r.outcome}`}>
              <td className="px-4 py-2 font-mono text-xs text-zinc-700">
                {r.source_slug}
              </td>
              <td className="px-4 py-2 text-zinc-700">{r.outcome}</td>
              <td className="px-4 py-2 text-right tabular-nums text-zinc-900">
                {r.count.toLocaleString('fr-FR')}
              </td>
            </tr>
          ))}
          <tr className="bg-zinc-50">
            <td colSpan={2} className="px-4 py-2 text-xs font-medium text-zinc-500">
              Total (post-dedupe par raw_input_hash)
            </td>
            <td className="px-4 py-2 text-right tabular-nums font-semibold text-zinc-900">
              {total.toLocaleString('fr-FR')}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function pct(num: number, denom: number): string | null {
  if (denom === 0) return null;
  return `${((num / denom) * 100).toFixed(1)}%`;
}
