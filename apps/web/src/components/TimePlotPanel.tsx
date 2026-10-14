import type { SignalInfo } from "@modelviz/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { client, signalStore, useSession } from "../state/session";

/** Visible time span of the live plot (seconds). */
const WINDOW_SECONDS = 10;
/** Redraw cap: the plot follows the display, never the Device's frame rate. */
const MIN_FRAME_MS = 33;

const PALETTE = ["#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

function groupByMessage(signals: SignalInfo[]): [string, SignalInfo[]][] {
  const groups = new Map<string, SignalInfo[]>();
  for (const s of signals) {
    const key = `${s.device}/${s.message}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups];
}

export function TimePlotPanel() {
  const { t } = useTranslation();
  const signals = useSession((s) => s.signals);
  const [selected, setSelected] = useState<string[]>([]);
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

  return (
    <section aria-labelledby="plot-heading" className="flex min-h-0 flex-1 gap-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex w-60 shrink-0 flex-col gap-2 overflow-auto">
        <h2 id="plot-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">
          {t("plot.heading")}
        </h2>
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
      <LivePlot signals={selectedSignals} />
    </section>
  );
}

function LivePlot({ signals }: { signals: SignalInfo[] }) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const [samples, setSamples] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el || signals.length === 0) return;
    // Canvas cannot resolve CSS variables, so read the theme colours once.
    const css = getComputedStyle(document.documentElement);
    const muted = css.getPropertyValue("--mv-muted").trim();
    const grid = css.getPropertyValue("--mv-border").trim();
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height: Math.max(200, el.clientHeight),
      scales: { x: { time: true } },
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
    };
    const plot = new uPlot(opts, [[], ...signals.map(() => [])], el);
    const resize = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: Math.max(200, el.clientHeight - 40) }));
    resize.observe(el);

    let raf = 0;
    let last = 0;
    let lastReceived = -1;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < MIN_FRAME_MS) return;
      last = now;
      const buffers = signals.map((s) => signalStore.buffer(s.handle));
      const received = buffers.reduce((n, b) => n + b.received, 0);
      if (received === lastReceived) return;
      lastReceived = received;
      const newest = Math.max(...buffers.map((b) => b.latestTime() ?? 0));
      const from = newest - WINDOW_SECONDS * 1000;
      const tables = buffers.map((b) => b.since(from) as uPlot.AlignedData);
      plot.setData(tables.length === 1 ? tables[0]! : uPlot.join(tables));
      setSamples(received);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      plot.destroy();
    };
  }, [signals]);

  return (
    <div className="relative min-h-0 min-w-0 flex-1" data-testid="time-plot" data-samples={samples}>
      {signals.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted">{t("plot.pickSignals")}</div>
      )}
      <div ref={host} className="h-full w-full" />
    </div>
  );
}
