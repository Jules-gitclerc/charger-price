// Renders one station_tariff card: confidence badge, payment method,
// source attribution, and the tariff's elements grouped by component
// dimension. Multi-price warning surfaces when >1 distinct ENERGY price
// is present (DC-T15-C). Server Component.

import type {
  StationTariffDetail,
  TariffElementDetail,
} from '../db/queries';
import { ConfidenceBadge } from './ConfidenceBadge';
import { TimeWindowBar } from './TimeWindowBar';

const COMPONENT_LABELS: Record<
  TariffElementDetail['components'][number]['type'],
  { label: string; unit: string }
> = {
  ENERGY: { label: 'Énergie', unit: '€/kWh' },
  TIME: { label: 'Temps de charge', unit: '€/h' },
  PARKING_TIME: { label: 'Stationnement', unit: '€/h' },
  FLAT: { label: 'Forfait session', unit: '€' },
};

function formatPrice(p: number, type: keyof typeof COMPONENT_LABELS): string {
  // ENERGY/TIME/PARKING_TIME: €/unit. FLAT: € flat.
  const formatted = p.toFixed(p < 1 ? 4 : 2);
  return `${formatted} ${COMPONENT_LABELS[type].unit}`;
}

function durationLabel(seconds: number | null): string | null {
  if (seconds === null) return null;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

function detectMultiPrice(elements: TariffElementDetail[]): boolean {
  const energyPrices = new Set<number>();
  for (const el of elements) {
    for (const c of el.components) {
      if (c.type === 'ENERGY') energyPrices.add(c.price);
    }
  }
  return energyPrices.size > 1;
}

export function TariffSummary({ tariff }: { tariff: StationTariffDetail }) {
  const isMultiPrice = detectMultiPrice(tariff.elements);
  const verifiedAt = new Date(tariff.last_verified_at);

  return (
    <article className="rounded-lg border border-zinc-200 bg-white p-4 shadow-sm">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <ConfidenceBadge confidence={tariff.confidence} />
        <span className="text-sm font-medium text-zinc-900">
          {tariff.payment_method_display_name}
        </span>
        {tariff.tariff_type && (
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-mono uppercase text-zinc-600">
            {tariff.tariff_type}
          </span>
        )}
        {isMultiPrice && (
          <span
            title="Tarif multi-tranches : plusieurs prix d'énergie selon la fenêtre horaire ou la puissance."
            className="rounded bg-yellow-50 px-1.5 py-0.5 text-[10px] font-medium text-yellow-800 ring-1 ring-inset ring-yellow-600/30"
          >
            ⚠️ Tarif multi-tranches
          </span>
        )}
      </header>

      {tariff.elements.length === 0 ? (
        <p className="text-sm text-zinc-500">Aucun élément tarifaire détaillé.</p>
      ) : (
        <ol className="space-y-3">
          {tariff.elements.map((el, idx) => (
            <li
              key={el.element_id}
              className="rounded border border-zinc-100 bg-zinc-50/50 p-3"
            >
              <div className="mb-2 text-[10px] font-mono uppercase text-zinc-500">
                Élément #{idx + 1}
              </div>
              <ul className="mb-2 space-y-1">
                {el.components.map((c, ci) => (
                  <li
                    key={ci}
                    className="flex items-baseline justify-between gap-4 text-sm"
                  >
                    <span className="text-zinc-700">
                      {COMPONENT_LABELS[c.type]?.label ?? c.type}
                    </span>
                    <span className="font-mono tabular-nums text-zinc-900">
                      {formatPrice(c.price, c.type)}
                      {c.vat !== null && (
                        <span className="ml-1 text-xs text-zinc-500">
                          (TVA {c.vat}%)
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {el.restriction && (
                <div className="mt-2 border-t border-zinc-200 pt-2">
                  {(el.restriction.start_time || el.restriction.end_time) && (
                    <div className="mb-2">
                      <TimeWindowBar
                        window={{
                          start_time: el.restriction.start_time,
                          end_time: el.restriction.end_time,
                        }}
                      />
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2 text-[10px] text-zinc-600">
                    {el.restriction.min_duration !== null && (
                      <span>
                        après {durationLabel(el.restriction.min_duration)}
                      </span>
                    )}
                    {el.restriction.max_duration !== null && (
                      <span>
                        jusqu&apos;à {durationLabel(el.restriction.max_duration)}
                      </span>
                    )}
                    {el.restriction.min_power !== null && (
                      <span>≥ {el.restriction.min_power} kW</span>
                    )}
                    {el.restriction.max_power !== null && (
                      <span>≤ {el.restriction.max_power} kW</span>
                    )}
                    {el.restriction.day_of_week && (
                      <span>{el.restriction.day_of_week.join(', ')}</span>
                    )}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      <footer className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-100 pt-3 text-[11px] text-zinc-500">
        <span>
          Source :{' '}
          <span className="font-mono text-zinc-700">{tariff.source_slug}</span>
        </span>
        {tariff.parser_version && (
          <span>
            Parser :{' '}
            <span className="font-mono text-zinc-700">
              {tariff.parser_version}
            </span>
          </span>
        )}
        <span>Vérifié le {verifiedAt.toLocaleDateString('fr-FR')}</span>
      </footer>
    </article>
  );
}
