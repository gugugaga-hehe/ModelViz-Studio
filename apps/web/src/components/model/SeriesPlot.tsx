import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface Series {
  label: string;
  values: number[];
  color: string;
  dashed?: boolean;
  /** Draw as sample points instead of a line (discrete-time data). */
  points?: boolean;
}

/** Static x/y plot for Analysis results (x in seconds, not wall-clock time). */
export function SeriesPlot({
  x,
  series,
  testId,
  xLabel = "t [s]",
  logX = false,
  height,
}: {
  x: number[];
  series: Series[];
  testId?: string;
  xLabel?: string;
  /** Logarithmic x axis (frequency plots). */
  logX?: boolean;
  height?: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el || !x.length) return;
    const css = getComputedStyle(document.documentElement);
    const muted = css.getPropertyValue("--mv-muted").trim();
    const grid = css.getPropertyValue("--mv-border").trim();
    const plot = new uPlot(
      {
        width: el.clientWidth,
        height: height ?? Math.max(200, el.clientHeight - 40),
        scales: { x: logX ? { time: false, distr: 3, log: 10 } : { time: false } },
        series: [
          { label: xLabel },
          ...series.map((s) => ({
            label: s.label,
            stroke: s.color,
            width: s.points ? 0 : 1.75,
            dash: s.dashed ? [4, 4] : [],
            points: s.points ? { show: true, size: 4, fill: s.color } : { show: false },
          })),
        ],
        axes: [
          { stroke: muted, grid: { stroke: grid } },
          { stroke: muted, grid: { stroke: grid } },
        ],
      },
      [x, ...series.map((s) => s.values)],
      el,
    );
    const ro = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: height ?? Math.max(200, el.clientHeight - 40) }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.destroy();
    };
  }, [x, series, xLabel, logX, height]);
  return (
    <div
      ref={host}
      className={`${height ? "" : "min-h-56 flex-1"} rounded border border-border bg-surface`}
      data-testid={testId}
      data-points={x.length}
    />
  );
}
