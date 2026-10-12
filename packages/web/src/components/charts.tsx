import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Hand-rolled SVG charts for the metrics page. Palette validated with the
 * dataviz skill's six-checks script against both surfaces (fixed series order,
 * never cycled): sent #2563eb, delivered #059669, complained #7c3aed,
 * bounced #dc2626. Marks are thin (2px lines, ≤10px bars), grid is recessive,
 * identity is never color-alone (legend + tooltip), and every plot ships a
 * hover layer.
 */

export const SERIES_COLORS = {
  sent: "#2563eb",
  delivered: "#059669",
  complained: "#7c3aed",
  bounced: "#dc2626",
  /** Inbound volume — its own single-series chart, validated standalone. */
  received: "#0d9488",
} as const;

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

export interface TimePoint {
  date: string;
  [key: string]: string | number;
}

function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width ?? 0;
      setWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** A rounded "nice" axis maximum so gridline labels land on round numbers. */
function niceMax(value: number): number {
  if (value <= 4) return 4;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const multiple of [1, 2, 2.5, 5, 10]) {
    if (value <= multiple * magnitude) return multiple * magnitude;
  }
  return 10 * magnitude;
}

function shortDate(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });
}

const MARGIN = { top: 8, right: 44, bottom: 22, left: 8 };

export function TimeSeriesChart({
  data,
  series,
  height = 260,
}: {
  data: TimePoint[];
  series: SeriesDef[];
  height?: number;
}) {
  const [containerRef, width] = useContainerWidth();
  const [hover, setHover] = useState<number | null>(null);

  const plotW = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const max = niceMax(
    Math.max(1, ...data.flatMap((point) => series.map((s) => Number(point[s.key]) || 0))),
  );

  const x = (index: number) =>
    MARGIN.left + (data.length <= 1 ? plotW / 2 : (index / (data.length - 1)) * plotW);
  const y = (value: number) => MARGIN.top + plotH - (value / max) * plotH;

  // biome-ignore lint/correctness/useExhaustiveDependencies: geometry derives from these only
  const paths = useMemo(
    () =>
      series.map((s) => {
        const line = data
          .map(
            (point, index) =>
              `${index === 0 ? "M" : "L"}${x(index)},${y(Number(point[s.key]) || 0)}`,
          )
          .join("");
        const area = `${line}L${x(data.length - 1)},${y(0)}L${x(0)},${y(0)}Z`;
        return { ...s, line, area };
      }),
    [data, series, width, max, plotH],
  );

  const gridSteps = [0.25, 0.5, 0.75, 1];
  const tickEvery = Math.max(1, Math.ceil(data.length / Math.max(Math.floor(plotW / 90), 2)));

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left - MARGIN.left;
    if (data.length === 0 || plotW <= 0) return;
    const index = Math.round((px / plotW) * (data.length - 1));
    setHover(Math.min(Math.max(index, 0), data.length - 1));
  };

  if (data.length === 0) return null;

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        role="img"
        aria-label="Daily email volume by outcome"
        width="100%"
        height={height}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
      >
        {gridSteps.map((step) => (
          <g key={step}>
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + plotW}
              y1={y(max * step)}
              y2={y(max * step)}
              stroke="currentColor"
              className="text-border"
              strokeDasharray="3 4"
              strokeWidth={1}
            />
            <text
              x={MARGIN.left + plotW + 8}
              y={y(max * step) + 3}
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {(max * step).toLocaleString()}
            </text>
          </g>
        ))}
        <line
          x1={MARGIN.left}
          x2={MARGIN.left + plotW}
          y1={y(0)}
          y2={y(0)}
          stroke="currentColor"
          className="text-border"
          strokeWidth={1}
        />

        {paths.map((s) => (
          <g key={s.key}>
            <path d={s.area} fill={s.color} opacity={0.07} />
            <path d={s.line} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
          </g>
        ))}

        {data.map((point, index) =>
          index % tickEvery === 0 ? (
            <text
              key={point.date}
              x={x(index)}
              y={height - 6}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {shortDate(point.date)}
            </text>
          ) : null,
        )}

        {hover !== null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={MARGIN.top}
              y2={y(0)}
              stroke="currentColor"
              className="text-muted-foreground/50"
              strokeWidth={1}
            />
            {series.map((s) => (
              <circle
                key={s.key}
                cx={x(hover)}
                cy={y(Number(data[hover][s.key]) || 0)}
                r={4}
                fill={s.color}
                stroke="var(--card)"
                strokeWidth={2}
              />
            ))}
          </g>
        )}
      </svg>

      {hover !== null && width > 0 && (
        <ChartTooltip xRatio={(x(hover) - MARGIN.left) / Math.max(plotW, 1)}>
          <p className="mb-1 font-medium">{shortDate(data[hover].date)}</p>
          {series.map((s) => (
            <p key={s.key} className="flex items-center gap-1.5 tabular-nums">
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: s.color }}
                aria-hidden="true"
              />
              <span className="text-muted-foreground">{s.label}</span>
              <span className="ml-auto pl-3 font-medium">
                {(Number(data[hover][s.key]) || 0).toLocaleString()}
              </span>
            </p>
          ))}
        </ChartTooltip>
      )}

      {/* A single series needs no legend — the card title names it. */}
      {series.length >= 2 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
          {series.map((s) => (
            <span
              key={s.key}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <span
                className="inline-block size-2 rounded-full"
                style={{ background: s.color }}
                aria-hidden="true"
              />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function RateBarChart({
  data,
  color,
  threshold,
  thresholdLabel = "RISK",
  yMax,
  height = 200,
}: {
  data: { date: string; value: number }[];
  color: string;
  /** Ratio (0–1) above which the metric is risky (drawn as a dashed rule). */
  threshold: number;
  thresholdLabel?: string;
  /** Axis max as ratio; defaults to a padding above threshold/data. */
  yMax?: number;
  height?: number;
}) {
  const [containerRef, width] = useContainerWidth();
  const [hover, setHover] = useState<number | null>(null);

  const plotW = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const dataMax = Math.max(...data.map((point) => point.value), 0);
  const max = yMax ?? Math.max(threshold * 2.5, dataMax * 1.25, 0.001);

  const slot = data.length > 0 ? plotW / data.length : plotW;
  const barW = Math.min(8, Math.max(2, slot * 0.4));
  const x = (index: number) => MARGIN.left + slot * index + slot / 2;
  const y = (value: number) => MARGIN.top + plotH - (Math.min(value, max) / max) * plotH;

  const gridSteps = [0.25, 0.5, 0.75, 1];
  const tickEvery = Math.max(1, Math.ceil(data.length / Math.max(Math.floor(plotW / 90), 2)));
  const pct = (value: number) =>
    `${(value * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;

  if (data.length === 0) return null;

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        role="img"
        aria-label="Daily rate with risk threshold"
        width="100%"
        height={height}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const index = Math.floor((event.clientX - rect.left - MARGIN.left) / Math.max(slot, 1));
          setHover(index >= 0 && index < data.length ? index : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {gridSteps.map((step) => (
          <g key={step}>
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + plotW}
              y1={y(max * step)}
              y2={y(max * step)}
              stroke="currentColor"
              className="text-border"
              strokeDasharray="3 4"
              strokeWidth={1}
            />
            <text
              x={MARGIN.left + plotW + 8}
              y={y(max * step) + 3}
              className="fill-muted-foreground text-[10px] tabular-nums"
            >
              {pct(max * step)}
            </text>
          </g>
        ))}
        <line
          x1={MARGIN.left}
          x2={MARGIN.left + plotW}
          y1={y(0)}
          y2={y(0)}
          stroke="currentColor"
          className="text-border"
          strokeWidth={1}
        />

        {/* Risk threshold: status accent + text label, never color alone. */}
        <line
          x1={MARGIN.left}
          x2={MARGIN.left + plotW}
          y1={y(threshold)}
          y2={y(threshold)}
          stroke="#f97316"
          strokeDasharray="4 3"
          strokeWidth={1}
        />
        <text
          x={MARGIN.left}
          y={y(threshold) - 4}
          className="fill-[#f97316] text-[9px] font-medium"
        >
          {thresholdLabel}
        </text>

        {data.map((point, index) => (
          <rect
            key={point.date}
            x={x(index) - barW / 2}
            y={point.value > 0 ? y(point.value) : y(0) - 1}
            width={barW}
            height={point.value > 0 ? Math.max(y(0) - y(point.value), 2) : 1}
            rx={2}
            fill={color}
            opacity={hover === null || hover === index ? 1 : 0.45}
          />
        ))}

        {data.map((point, index) =>
          index % tickEvery === 0 ? (
            <text
              key={point.date}
              x={x(index)}
              y={height - 6}
              textAnchor="middle"
              className="fill-muted-foreground text-[10px]"
            >
              {shortDate(point.date)}
            </text>
          ) : null,
        )}
      </svg>

      {hover !== null && width > 0 && (
        <ChartTooltip xRatio={(x(hover) - MARGIN.left) / Math.max(plotW, 1)}>
          <p className="mb-0.5 font-medium">{shortDate(data[hover].date)}</p>
          <p className="tabular-nums text-muted-foreground">{pct(data[hover].value)}</p>
        </ChartTooltip>
      )}
    </div>
  );
}

/** Anchored tooltip that flips sides at the plot midpoint so it never clips. */
function ChartTooltip({ xRatio, children }: { xRatio: number; children: React.ReactNode }) {
  const onLeft = xRatio > 0.55;
  return (
    <div
      className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
      style={
        onLeft
          ? { right: `${(1 - xRatio) * 100}%`, marginRight: 12 }
          : { left: `${xRatio * 100}%`, marginLeft: 12 }
      }
    >
      {children}
    </div>
  );
}
