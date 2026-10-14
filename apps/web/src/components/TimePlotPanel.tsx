import type { SignalInfo } from "@modelviz/protocol";
import { Pause, Play, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { client, signalStore, useSession } from "../state/session";
import { HISTORY_SECONDS } from "../state/signal-store";
import { alignedSince, wheelZoomPanPlugin } from "./plot-data";

/** Visible time span of the live plot (seconds). */
const WINDOW_SECONDS = 10;
/** Redraw cap: the plot follows the display, never the Device's frame rate. */
const MIN_FRAME_MS = 33;
/** Cursor sync group shared by all time plots. */
const SYNC_KEY = "time-plots";

const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

function groupByMessage(signals: SignalInfo[]): [string, SignalInfo[]][] {
  const groups = new Map<string, SignalInfo[]>();
  for (const s of signals) {
    const key = `${s.device}/${s.message}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups];
}

export function TimePlotPanel({ index, onRemove }: { index: number; onRemove?: () => void }) {
  const { t } = useTranslation();
  const signals = useSession((s) => s.signals);
  const [selected, setSelected] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const selectedSignals = useMemo(
    () => selected.map((id) => signals.find((s) => s.id === id)).filter((s): s is SignalInfo => !!s),
    [selected, signals],
  );

  // Drop selections that no longer exist (e.g. after switching Project).
  useEffect(() => {
    setSelected((sel) => sel.filter((id) => signals.some((s) => s.id === id)));
  }, [signals]);

  // Keep the server subscription in sync with the selection.
  useEffect(() => {
    const ids = selectedSignals.map((s) => s.id);
    if (!ids.length) return;
    void client.request("signals.subscribe", { ids }).catch(() => {});
    return () => void client.request("signals.unsubscribe", { ids }).catch(() => {});
  }, [selectedSignals]);

  const toggle = (id: string) => setSelected((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]));
  const title = t("plot.title", { n: index + 1 });

  return (
    <section
      aria-label={title}
      data-testid={`time-plot-panel-${index}`}
      className="flex min-h-64 flex-1 gap-3 rounded-lg border border-border bg-surface p-3"
    >
      <div className="flex w-60 shrink-0 flex-col gap-2 overflow-auto">
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
          {onRemove && (
            <button onClick={onRemove} aria-label={t("plot.remove")} className="rounded p-0.5 text-muted hover:text-fg">
              <X size={14} />
            </button>
          )}
        </div>
        {signals.length === 0 && <p className="text-sm text-muted">{t("plot.noSignals")}</p>}
        {groupByMessage(signals).map(([group, list]) => (
          <fieldset key={group} className="text-sm">
            <legend className="mb-1 text-xs text-muted">{group}</legend>
            {list.map((s) => (
              <label key={s.id} className="flex items-center gap-2 py-0.5">
                <input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} aria-label={s.id} />
                <span>{s.field}</span>
                {s.units && <span className="text-xs text-muted">[{s.units}]</span>}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <LivePlot signals={selectedSignals} paused={paused} />
    </section>
  );
}

function LivePlot({ signals, paused }: { signals: SignalInfo[]; paused: boolean }) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const pausedRef = useRef(paused);
  const [samples, setSamples] = useState(0);
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
            if (key !== "x") return;
            const span = (u.scales.x!.max ?? 0) - (u.scales.x!.min ?? 0);
            el.parentElement?.setAttribute("data-x-span", span.toFixed(3));
          },
        ],
      },
    };
    const plot = new uPlot(opts, [[], ...signals.map(() => [])], el);
    plotRef.current = plot;
    const resize = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: Math.max(160, el.clientHeight - 40) }));
    resize.observe(el);

    let raf = 0;
    let last = 0;
    let lastReceived = -1;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (pausedRef.current || now - last < MIN_FRAME_MS) return;
      last = now;
      const buffers = signals.map((s) => signalStore.buffer(s.handle));
      const received = buffers.reduce((n, b) => n + b.received, 0);
      if (received === lastReceived) return;
      lastReceived = received;
      const newest = Math.max(...buffers.map((b) => b.latestTime() ?? 0));
      plot.setData(alignedSince(buffers, newest - WINDOW_SECONDS * 1000));
      setSamples(received);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [signals]);

  // On pause, load the whole buffered history but keep showing the current window.
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || !paused) return;
    const buffers = signals.map((s) => signalStore.buffer(s.handle));
    const newest = Math.max(...buffers.map((b) => b.latestTime() ?? 0));
    const xMax = newest / 1000;
    plot.setData(alignedSince(buffers, newest - HISTORY_SECONDS * 1000), false);
    plot.setScale("x", { min: xMax - WINDOW_SECONDS, max: xMax });
  }, [paused, signals]);

  return (
    <div
      className="relative min-h-0 min-w-0 flex-1"
      data-testid="time-plot"
      data-samples={samples}
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
