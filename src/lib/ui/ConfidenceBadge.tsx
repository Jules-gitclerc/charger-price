// Confidence-tier badge — the single most important UX atom of T15.
// Renders one of the 4 schema enum values from live.station_tariffs.confidence
// (CHECK constraint in supabase/migrations/0005_provenance.sql:158).
//
// Per docs/02-architecture.md §1.3, confidence propagates DB → API → UI
// without losing meaning. This component is the UI terminus.
//
// M1 data has 'parsed' only (T13.2 wrote 6,970 such rows). The other three
// tiers render correctly when given test data — 'verified' lands with T14
// Fastned scraper; 'estimated' and 'unknown' land later. M1.5+ work.
//
// Server Component (no 'use client') — pure presentational, no state.

export type Confidence = 'verified' | 'parsed' | 'estimated' | 'unknown';

const STYLES: Record<
  Confidence,
  { bg: string; text: string; ring: string; icon: string; label: string; tip: string }
> = {
  verified: {
    bg: 'bg-green-50',
    text: 'text-green-700',
    ring: 'ring-green-600/30',
    icon: '✅',
    label: 'Vérifié',
    tip: 'Source opérateur direct, vérifié il y a moins de 7 jours.',
  },
  parsed: {
    bg: 'bg-amber-50',
    text: 'text-amber-700',
    ring: 'ring-amber-600/30',
    icon: '📄',
    label: 'Estimé IRVE',
    tip: 'Champ libre IRVE analysé par un parser interne.',
  },
  estimated: {
    bg: 'bg-slate-100',
    text: 'text-slate-700',
    ring: 'ring-slate-500/30',
    icon: '📊',
    label: 'Moyenne réseau',
    tip: 'Estimation par moyenne du réseau opérateur.',
  },
  unknown: {
    bg: 'bg-orange-50',
    text: 'text-orange-700',
    ring: 'ring-orange-600/30',
    icon: '❓',
    label: 'Non communiqué',
    tip: 'Aucun tarif déclaré par l’opérateur.',
  },
};

export function ConfidenceBadge({
  confidence,
  size = 'sm',
}: {
  confidence: Confidence;
  size?: 'sm' | 'xs';
}) {
  const s = STYLES[confidence];
  const sizing =
    size === 'xs'
      ? 'px-1.5 py-0.5 text-[10px]'
      : 'px-2 py-0.5 text-xs';
  return (
    <span
      title={s.tip}
      className={`inline-flex items-center gap-1 rounded font-medium ring-1 ring-inset ${s.bg} ${s.text} ${s.ring} ${sizing}`}
    >
      <span aria-hidden>{s.icon}</span>
      <span>{s.label}</span>
    </span>
  );
}
