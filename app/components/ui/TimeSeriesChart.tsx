'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

export interface TimeSeriesPoint {
  /** Seconds since the epoch — the start of the bucket. */
  ts: number;
  /** The plotted value (an average over the bucket); null leaves a gap. */
  value: number | null;
  /** The bucket's peak, drawn as a light wash under the line and shown in the tooltip. */
  peak?: number | null;
}

interface TimeSeriesChartProps {
  /** What is plotted, for screen readers and the table caption. */
  label: string;
  points: TimeSeriesPoint[];
  /** The x domain in seconds, so an empty stretch reads as "no data", not as a zoom. */
  from: number;
  to: number;
  /** Seconds per point; two points further apart than 1.5 buckets are not joined. */
  bucket: number;
  /**
   * The top of the y axis. A number fixes it (100 for a percentage); `'auto'` takes a rounded
   * ceiling just above the highest value or peak plotted — for a series that is a small
   * fraction of its natural scale, like one agent's share of the machine.
   */
  yMax?: number | 'auto';
  unit?: string;
  /** Formats a value (grid labels, end label, tooltip, table) instead of `<rounded><unit>` — e.g. dollars. */
  formatValue?: (v: number) => string;
  height?: number;
  /** While a new range loads the previous render stays, dimmed. */
  stale?: boolean;
  formatTime: (ts: number) => string;
}

/** A rounded ceiling (1, 2 or 5 times a power of ten) just above the highest value or peak. */
function autoYMax(points: TimeSeriesPoint[]): number {
  let top = 0;
  for (const p of points) top = Math.max(top, p.value ?? 0, p.peak ?? 0);
  if (!(top > 0)) return 1;
  const target = top * 1.1;
  const base = 10 ** Math.floor(Math.log10(target));
  const m = target / base;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * base;
}

const PAD = { top: 12, right: 44, bottom: 22, left: 34 };
/** Width of one character of the 10 px monospace labels, for sizing the margins. */
const CHAR_W = 6.2;

/**
 * One series over time: a 2px line for the value, a 10% wash up to the peak, a hairline
 * grid at 0 / 50 / 100 %, the latest value labelled at the line's end. Hover or focus
 * shows a crosshair snapped to the nearest point with its value and peak; the same data
 * is available as a table. Plain SVG measured to its container, so text is never scaled.
 */
export function TimeSeriesChart({
  label,
  points,
  from,
  to,
  bucket,
  yMax: yMaxProp = 100,
  unit = '%',
  formatValue,
  height = 160,
  stale = false,
  formatTime,
}: TimeSeriesChartProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const clipId = `ts-clip-${useId().replace(/:/g, '')}`;
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const yMax = yMaxProp === 'auto' ? autoYMax(points) : yMaxProp;

  // With a custom format (`$0.0054`) the margins grow to fit the labels instead of cutting
  // them; percentage charts keep the fixed margins.
  const valueText = (v: number) => (formatValue ? formatValue(v) : `${Math.round(v * 10) / 10}${unit}`);
  const tickText = (v: number) => (formatValue ? formatValue(v) : `${Math.round(v)}${unit}`);
  const tickValues = [0, 50, 100].map((v) => (v / 100) * yMax);
  const lastValue = [...points].reverse().find((p) => p.value !== null)?.value ?? null;
  const padLeft = formatValue
    ? Math.max(PAD.left, Math.ceil(Math.max(...tickValues.map((v) => tickText(v).length)) * CHAR_W) + 8)
    : PAD.left;
  const padRight = formatValue && lastValue !== null
    ? Math.max(PAD.right, Math.ceil(valueText(lastValue).length * CHAR_W) + 14)
    : PAD.right;
  const plotW = Math.max(0, width - padLeft - padRight);
  const plotH = height - PAD.top - PAD.bottom;
  const span = Math.max(1, to - from);
  const x = (ts: number) => padLeft + ((ts - from) / span) * plotW;
  const y = (v: number) => PAD.top + plotH - (Math.max(0, Math.min(yMax, v)) / yMax) * plotH;

  const valid = useMemo(() => points.filter((p) => p.value !== null), [points]);

  // Runs of points close enough in time to be joined; a gap means no samples there.
  const runs = useMemo(() => {
    const out: TimeSeriesPoint[][] = [];
    let run: TimeSeriesPoint[] = [];
    for (const p of valid) {
      const prev = run[run.length - 1];
      if (prev && p.ts - prev.ts > bucket * 1.5) {
        out.push(run);
        run = [];
      }
      run.push(p);
    }
    if (run.length) out.push(run);
    return out;
  }, [valid, bucket]);

  const linePath = (run: TimeSeriesPoint[]) =>
    run.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.value as number).toFixed(1)}`).join('');
  const peakArea = (run: TimeSeriesPoint[]) => {
    const top = run.map((p, i) => `${i ? 'L' : 'M'}${x(p.ts).toFixed(1)},${y(p.peak ?? (p.value as number)).toFixed(1)}`).join('');
    const base = y(0).toFixed(1);
    return `${top}L${x(run[run.length - 1].ts).toFixed(1)},${base}L${x(run[0].ts).toFixed(1)},${base}Z`;
  };

  const last = valid[valid.length - 1];
  const shown = active !== null ? valid[active] : null;
  const fmt = (v: number | null | undefined) =>
    v === null || v === undefined ? '—' : valueText(v);

  function onPointerMove(e: PointerEvent<SVGRectElement>) {
    if (!valid.length || plotW <= 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ts = from + ((e.clientX - rect.left) / rect.width) * span;
    let best = 0;
    for (let i = 1; i < valid.length; i++) {
      if (Math.abs(valid[i].ts - ts) < Math.abs(valid[best].ts - ts)) best = i;
    }
    setActive(best);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (!valid.length) return;
    if (e.key === 'ArrowLeft') setActive((a) => Math.max(0, (a ?? valid.length) - 1));
    else if (e.key === 'ArrowRight') setActive((a) => Math.min(valid.length - 1, (a ?? -1) + 1));
    else if (e.key === 'Escape') setActive(null);
    else return;
    e.preventDefault();
  }

  const ticks = [from, from + span / 2, to];
  const tooltipLeft = shown ? Math.min(Math.max(x(shown.ts), 70), Math.max(70, width - 70)) : 0;

  return (
    <div className="ui-chart" style={{ opacity: stale ? 0.5 : 1 }}>
      <div
        ref={boxRef}
        className="ui-chart__plot"
        style={{ height }}
        tabIndex={0}
        role="img"
        aria-label={last ? `${label}: latest ${fmt(last.value)}` : `${label}: no data`}
        onKeyDown={onKeyDown}
        onFocus={() => setActive((a) => a ?? (valid.length ? valid.length - 1 : null))}
        onBlur={() => setActive(null)}
      >
        {width > 0 && (
          <svg width={width} height={height} aria-hidden="true">
            {[0, 50, 100].map((v) => (
              <g key={v}>
                <line x1={padLeft} x2={padLeft + plotW} y1={y((v / 100) * yMax)} y2={y((v / 100) * yMax)} className="ui-chart__grid" />
                <text x={padLeft - 6} y={y((v / 100) * yMax) + 3} textAnchor="end" className="ui-chart__tick">
                  {tickText((v / 100) * yMax)}
                </text>
              </g>
            ))}
            {ticks.map((ts, i) => (
              <text
                key={i}
                x={x(ts)}
                y={height - 6}
                textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
                className="ui-chart__tick"
              >
                {formatTime(ts)}
              </text>
            ))}
            <defs>
              {/* Marks stay inside the plot, never over the axis labels. */}
              <clipPath id={clipId}>
                <rect x={padLeft} y={0} width={plotW} height={PAD.top + plotH} />
              </clipPath>
            </defs>
            <g clipPath={`url(#${clipId})`}>
            {runs.map((run, i) => (
              <g key={i}>
                <path d={peakArea(run)} className="ui-chart__wash" />
                {run.length > 1 && <path d={linePath(run)} className="ui-chart__line" />}
                {run.length === 1 && <circle cx={x(run[0].ts)} cy={y(run[0].value as number)} r={2} className="ui-chart__dot" />}
              </g>
            ))}
            </g>
            {last && !shown && (
              <g>
                <circle cx={x(last.ts)} cy={y(last.value as number)} r={4} className="ui-chart__marker" />
                <text x={x(last.ts) + 8} y={y(last.value as number) + 3} className="ui-chart__end-label">{fmt(last.value)}</text>
              </g>
            )}
            {shown && (
              <g>
                <line x1={x(shown.ts)} x2={x(shown.ts)} y1={PAD.top} y2={PAD.top + plotH} className="ui-chart__crosshair" />
                <circle cx={x(shown.ts)} cy={y(shown.value as number)} r={4} className="ui-chart__marker" />
              </g>
            )}
            {!valid.length && (
              <text x={padLeft + plotW / 2} y={PAD.top + plotH / 2} textAnchor="middle" className="ui-chart__tick">No samples in this range</text>
            )}
            <rect
              x={padLeft}
              y={PAD.top}
              width={plotW}
              height={plotH}
              fill="transparent"
              onPointerMove={onPointerMove}
              onPointerLeave={() => setActive(null)}
            />
          </svg>
        )}
        {shown && (
          <div className="ui-chart__tooltip" style={{ left: tooltipLeft }}>
            <strong>{fmt(shown.value)}</strong>
            {shown.peak !== undefined && <span className="ui-muted"> · peak {fmt(shown.peak)}</span>}
            <div className="ui-muted">{formatTime(shown.ts)}</div>
          </div>
        )}
      </div>
      <details className="ui-chart__table">
        <summary>Table</summary>
        <table>
          <caption>{label}</caption>
          <thead>
            <tr><th scope="col">Time</th><th scope="col">Value</th>{valid.some((p) => p.peak !== undefined) && <th scope="col">Peak</th>}</tr>
          </thead>
          <tbody>
            {valid.map((p) => (
              <tr key={p.ts}>
                <td>{formatTime(p.ts)}</td>
                <td>{fmt(p.value)}</td>
                {p.peak !== undefined && <td>{fmt(p.peak)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
