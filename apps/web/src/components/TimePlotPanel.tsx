import type { SignalInfo } from "@modelviz/protocol";
import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { retainSignals, signalStore } from "../state/session";
import { SignalPicker, useSignalsById } from "./panels/SignalPicker";
import { alignedWindow, wheelZoomPanPlugin } from "./plot-data";

/** Visible time span of the live plot (seconds). */
const WINDOW_SECONDS = 10;
/** Redraw cap: the plot follows the display, never the Device's frame rate. */
const MIN_FRAME_MS = 33;
/** Cursor sync group shared by all time plots. */
const SYNC_KEY = "time-plots";

export const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

/** Keeps the selected Signals subscribed while the Panel shows them. */
export function useRetained(signals: SignalInfo[]): void {
  useEffect(() => {
    if (!signals.length) return;
    return retainSignals(signals.map((s) => s.id));
  }, [signals]);
}

/** A live time plot Panel; `selected` lives in the Panel layout so it is saved with the Project. */
export function TimePlotPanel({ n, selected, onChange }: { n: number; selected: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const [paused, setPaused] = useState(false);
  const selectedSignals = useSignalsById(selected);
  useRetained(selectedSignals);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const title = t("plot.title", { n });

  return (
    <section aria-label={title} data-testid={`time-plot-panel-${n - 1}`} className="@container h-full min-h-0 bg-surface p-3">
      <div className="flex h-full min-h-0 flex-col gap-3 @[36rem]:flex-row">
        <div className="flex max-h-40 shrink-0 flex-col gap-2 overflow-auto @[36rem]:max-h-none @[36rem]:w-60">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
            <button
              onClick={() => setPaused((p) => !p)}
              disabled={!selectedSignals.length}
              className="ml-auto inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs disabled:opacity-40"
            >
              {paused ? <Play size={12} /> : <Pause size={12} />}
              {t(paused ? "plot.resume" : "plot.pause")}
            </button>
          </div>
          <SignalPicker selected={selected} onToggle={toggle} />
        </div>
        <LivePlot signals={selectedSignals} paused={paused} />
      </div>
    </section>
  );
}

function LivePlot({ signals, paused }: { signals: SignalInfo[]; paused: boolean }) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  /** Re-reads the buffers for the visible x range (set while the plot exists). */
  const pausedRange = useRef<(() => void) | null>(null);
  const pausedRef = useRef(paused);
  const [samples, setSamples] = useState(0);
  /** Points handed to the plot in the last update, per Signal (for tests: bounded by the width). */
  const [points, setPoints] = useState(0);
  const [frames, setFrames] = useState(0);
  pausedRef.current = paused;

  useEffect(() => {
    const el = host.current;
    if (!el || signals.length === 0) return;
    // Canvas cannot resolve CSS variables, so read the theme colours once.
    const css = getComputedStyle(document.documentElement);
    const muted = css.getPropertyValue("--mv-muted").trim();
    const grid = css.getPropertyValue("--mv-border").trim();
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: Math.max(160, el.clientHeight - 40),
      scales: { x: { time: true } },
      cursor: {
        sync: { key: SYNC_KEY, setSeries: false },
        // Drag-to-zoom; while live the next redraw returns to the newest window anyway.
        drag: { x: true, y: false, setScale: true },
      },
      series: [
        {},
        ...signals.map((s, i) => ({
          label: s.id,
          stroke: PALETTE[i % PALETTE.length],
          width: 1.5,
          spanGaps: true,
          points: { show: false },
        })),
      ],
      axes: [
        { stroke: muted, grid: { stroke: grid } },
        { stroke: muted, grid: { stroke: grid } },
      ],
      legend: { live: true },
      plugins: [wheelZoomPanPlugin(() => {})],
      hooks: {
        // Expose the visible range for tests and assistive tooling.
        setScale: [
          (u, key) => {
            if (key === "y") el.parentElement?.setAttribute("data-y-span", ((u.scales.y!.max ?? 0) - (u.scales.y!.min ?? 0)).toFixed(3));
            if (key !== "x") return;
            const span = (u.scales.x!.max ?? 0) - (u.scales.x!.min ?? 0);
            el.parentElement?.setAttribute("data-x-span", span.toFixed(3));
            // paused: zooming or panning re-reads the buffer for the new range at full detail
            if (pausedRef.current) scheduleRange();
          },
        ],
      },
    };
    const plot = new uPlot(opts, [[], ...signals.map(() => [])], el);
    plotRef.current = plot;
    const buffers = signals.map((s) => signalStore.buffer(s.handle));
    /** One envelope column per device pixel of the plotting area. */
    const columns = () => Math.max(16, Math.round(plot.bbox.width || el.clientWidth * devicePixelRatio));
    const show = (data: uPlot.AlignedData, resetScales: boolean) => {
      plot.setData(data, resetScales);
      setPoints(data[1]?.length ?? 0);
      setFrames((f) => f + 1);
    };
    // While paused, the visible range plus one span either side, so panning has data at once.
    let rangeRaf = 0;
    function scheduleRange() {
      cancelAnimationFrame(rangeRaf);
      rangeRaf = requestAnimationFrame(() => {
        const { min, max } = plot.scales.x!;
        if (min === undefined || max === undefined) return;
        const span = max - min;
        show(alignedWindow(buffers, (min - span) * 1000, (max + span) * 1000, columns() * 3), false);
      });
    }
    pausedRange.current = scheduleRange;
    const resize = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: Math.max(160, el.clientHeight - 40) }));
    resize.observe(el);

    let raf = 0;
    let last = 0;
    let lastReceived = -1;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (pausedRef.current || now - last < MIN_FRAME_MS) return;
      last = now;
      const received = buffers.reduce((n, b) => n + b.received, 0);
      if (received === lastReceived) return;
      lastReceived = received;
      const newest = Math.max(...buffers.map((b) => b.latestTime() ?? 0));
      show(alignedWindow(buffers, newest - WINDOW_SECONDS * 1000, newest, columns()), true);
      setSamples(received);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(rangeRaf);
      pausedRange.current = null;
      resize.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [signals]);

  // On pause, keep showing the current window; zooming and panning then load data for the range shown.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || !paused) return;
    const newest = Math.max(...signals.map((s) => signalStore.buffer(s.handle).latestTime() ?? 0));
    const xMax = newest / 1000;
    plot.setScale("x", { min: xMax - WINDOW_SECONDS, max: xMax });
    pausedRange.current?.();
  }, [paused, signals]);

  return (
    <div
      className="relative min-h-40 min-w-0 flex-1"
      data-testid="time-plot"
      data-samples={samples}
      data-points={points}
      data-frames={frames}
      data-paused={paused}
      title={paused ? t("plot.pausedHint") : undefined}
    >
      {signals.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">{t("plot.pickSignals")}</div>
      )}
      <div ref={host} className="h-full w-full" />
    </div>
  );
}
