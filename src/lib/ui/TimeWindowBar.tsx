// 24-hour CSS bar for visualizing tariff time-of-day restrictions.
// Pure CSS grid (DC-T15-E), no chart library. Server Component.
//
// Renders a single horizontal row of 24 segments. Cells inside the
// [start_time, end_time] window are filled; cells outside are muted.
// Falls back to a text-only summary when no window is active or when
// the window covers the whole day.

export type TimeWindow = {
  start_time: string | null;
  end_time: string | null;
};

function parseHour(hhmm: string | null): number | null {
  if (!hhmm) return null;
  const [h] = hhmm.split(':');
  const n = Number(h);
  return Number.isFinite(n) && n >= 0 && n <= 24 ? n : null;
}

export function TimeWindowBar({ window: w }: { window: TimeWindow }) {
  const startH = parseHour(w.start_time);
  const endH = parseHour(w.end_time);

  if (startH === null || endH === null) {
    return <span className="text-xs text-zinc-500">Toute la journée</span>;
  }

  // Compute which of 24 hour-cells fall inside the window. Supports
  // overnight windows (e.g. 22:00 → 06:00 = hours 22,23,0,1,2,3,4,5).
  const inWindow: boolean[] = Array.from({ length: 24 }, (_, i) => {
    if (startH < endH) return i >= startH && i < endH;
    return i >= startH || i < endH;
  });

  return (
    <div>
      <div
        className="grid gap-px overflow-hidden rounded border border-zinc-200 bg-zinc-200"
        style={{ gridTemplateColumns: 'repeat(24, minmax(0, 1fr))' }}
      >
        {inWindow.map((on, i) => (
          <div
            key={i}
            title={`${i.toString().padStart(2, '0')}:00`}
            className={`h-3 ${on ? 'bg-amber-400' : 'bg-zinc-50'}`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-zinc-500">
        <span>00h</span>
        <span>06h</span>
        <span>12h</span>
        <span>18h</span>
        <span>24h</span>
      </div>
      <div className="mt-1 text-xs text-zinc-700">
        {w.start_time} → {w.end_time}
      </div>
    </div>
  );
}
