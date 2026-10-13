import { useEffect, useRef, useState } from "react";

/** Sequential colour ramp (dark blue → teal → yellow), readable in light and dark themes. */
const STOPS: [number, number, number][] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];
function ramp(t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (STOPS.length - 1);
  const i = Math.min(STOPS.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [STOPS[i]!, STOPS[i + 1]!];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k]! - v) * f)).join(",")})`;
}

const fmt = (v: number) => Number(v.toPrecision(4)).toString();

/** 2-D Parameter Sweep: rows = first axis (y), columns = second axis (x). */
export function Heatmap({
  rows,
  cols,
  values,
  rowLabel,
  colLabel,
  metric,
}: {
  rows: number[];
  cols: number[];
  values: (number | null)[][];
  rowLabel: string;
  colLabel: string;
  metric: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ i: number; j: number } | null>(null);
  const flat = values.flat().filter((v): v is number => v !== null);
  const lo = Math.min(...flat);
  const hi = Math.max(...flat);
  const W = 420;
  const H = 300;

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const dpr = devicePixelRatio;
    c.width = W * dpr;
    c.height = H * dpr;
    ctx.scale(dpr, dpr);
    const cw = W / cols.length;
    const ch = H / rows.length;
    values.forEach((row, i) =>
      row.forEach((v, j) => {
        // first row at the bottom, like a y axis
        const y = H - (i + 1) * ch;
        ctx.fillStyle = v === null ? "rgba(128,128,128,0.25)" : ramp(hi === lo ? 0.5 : (v - lo) / (hi - lo));
        // overlap by a pixel so fractional cell sizes leave no seams
        ctx.fillRect(Math.floor(j * cw), Math.floor(y), Math.ceil(cw) + 1, Math.ceil(ch) + 1);
      }),
    );
  }, [values, rows, cols, lo, hi]);

  const cell = hover ? values[hover.i]?.[hover.j] : undefined;
  return (
    <figure className="flex flex-col gap-1 text-xs" data-testid="sweep-heatmap" data-rows={rows.length} data-cols={cols.length}>
      <div className="flex items-stretch gap-2">
        <div className="flex flex-col justify-between py-1 text-right text-muted">
          <span>{fmt(rows.at(-1)!)}</span>
          <span className="[writing-mode:vertical-rl] rotate-180 self-center">{rowLabel}</span>
          <span>{fmt(rows[0]!)}</span>
        </div>
        <div className="flex flex-col">
          <canvas
            ref={canvas}
            style={{ width: W, height: H }}
            className="rounded border border-border"
            onMouseMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              const j = Math.min(cols.length - 1, Math.floor(((e.clientX - r.left) / r.width) * cols.length));
              const i = Math.min(rows.length - 1, rows.length - 1 - Math.floor(((e.clientY - r.top) / r.height) * rows.length));
              setHover({ i, j });
            }}
            onMouseLeave={() => setHover(null)}
            aria-label={`${metric} over ${rowLabel} × ${colLabel}`}
            role="img"
          />
          <div className="flex justify-between text-muted">
            <span>{fmt(cols[0]!)}</span>
            <span>{colLabel}</span>
            <span>{fmt(cols.at(-1)!)}</span>
          </div>
        </div>
        <div className="flex flex-col items-center gap-1">
          <span className="text-muted">{fmt(hi)}</span>
          <div className="w-3 flex-1 rounded" style={{ background: `linear-gradient(to top, ${STOPS.map((_, k) => ramp(k / (STOPS.length - 1))).join(",")})` }} />
          <span className="text-muted">{fmt(lo)}</span>
        </div>
      </div>
      <figcaption className="h-4 tabular-nums" data-testid="heatmap-hover">
        {hover && (
          <>
            {rowLabel} = {fmt(rows[hover.i]!)}, {colLabel} = {fmt(cols[hover.j]!)} → {metric} = {cell === null || cell === undefined ? "—" : fmt(cell)}
          </>
        )}
      </figcaption>
    </figure>
  );
}
