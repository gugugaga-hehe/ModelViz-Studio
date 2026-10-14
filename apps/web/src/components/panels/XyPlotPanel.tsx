import type { SignalInfo } from "@modelviz/protocol";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { signalStore } from "../../state/session";
import { niceTicks, pairsSince } from "../plot-data";
import { useRetained } from "../TimePlotPanel";
import { SignalSelect, useSignalsById } from "./SignalPicker";

/** Trail length of the XY plot (seconds). */
const WINDOW_SECONDS = 10;
const MIN_FRAME_MS = 33;

/** One Signal plotted against another over the last few seconds. */
export function XyPlotPanel({ n, x, y, onChange }: { n: number; x: string; y: string; onChange: (p: { x: string; y: string }) => void }) {
  const { t } = useTranslation();
  const [xs, ys] = [useSignalsById(x ? [x] : []), useSignalsById(y ? [y] : [])];
  const both = xs.length && ys.length ? ([xs[0]!, ys[0]!] as const) : null;
  useRetained(xs);
  useRetained(ys);
  const title = t("panels.xyTitle", { n });
  return (
    <section aria-label={title} data-testid={`xy-plot-panel-${n - 1}`} className="@container flex h-full min-h-0 flex-col gap-3 bg-surface p-3 @[36rem]:flex-row">
      <div className="flex max-h-40 shrink-0 flex-col gap-2 overflow-auto @[36rem]:max-h-none @[36rem]:w-60">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
        <SignalSelect label={t("panels.xSignal")} value={x} onChange={(v) => onChange({ x: v, y })} />
        <SignalSelect label={t("panels.ySignal")} value={y} onChange={(v) => onChange({ x, y: v })} />
      </div>
      {both ? <XyCanvas x={both[0]} y={both[1]} /> : <Empty text={t("panels.pickXy")} />}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="flex min-w-0 flex-1 items-center justify-center text-sm text-muted">{text}</div>;
}

function label(s: SignalInfo): string {
  return s.units ? `${s.id} [${s.units}]` : s.id;
}

function XyCanvas({ x, y }: { x: SignalInfo; y: SignalInfo }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [points, setPoints] = useState(0);

  useEffect(() => {
    const el = canvas.current!;
    const css = getComputedStyle(document.documentElement);
    const colors = {
      fg: css.getPropertyValue("--mv-fg").trim(),
      muted: css.getPropertyValue("--mv-muted").trim(),
      grid: css.getPropertyValue("--mv-border").trim(),
      line: css.getPropertyValue("--mv-accent").trim(),
    };
    let raf = 0;
    let last = 0;
    let lastReceived = -1;
    let lastSize = "";
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < MIN_FRAME_MS) return;
      last = now;
      const xb = signalStore.buffer(x.handle);
      const yb = signalStore.buffer(y.handle);
      const size = `${el.clientWidth}x${el.clientHeight}`;
      const received = xb.received + yb.received;
      if (received === lastReceived && size === lastSize) return;
      lastReceived = received;
      lastSize = size;
      const newest = Math.max(xb.latestTime() ?? 0, yb.latestTime() ?? 0);
      const { xs, ys } = pairsSince(xb, yb, newest - WINDOW_SECONDS * 1000);
      draw(el, xs, ys, label(x), label(y), colors);
      setPoints(xs.length);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [x, y]);

  return (
    <div className="relative min-h-40 min-w-0 flex-1" data-testid="xy-plot" data-points={points}>
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
    </div>
  );
}

function draw(
  el: HTMLCanvasElement,
  xs: number[],
  ys: number[],
  xLabel: string,
  yLabel: string,
  c: { fg: string; muted: string; grid: string; line: string },
): void {
  const dpr = devicePixelRatio || 1;
  const w = el.clientWidth;
  const h = el.clientHeight;
  el.width = Math.round(w * dpr);
  el.height = Math.round(h * dpr);
  const g = el.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.font = "11px system-ui, sans-serif";
  const pad = { l: 56, r: 12, t: 12, b: 40 };
  const pw = w - pad.l - pad.r;
  const ph = h - pad.t - pad.b;
  if (pw < 20 || ph < 20) return;

  const range = (v: number[]) => {
    // a loop, not Math.min(...v): v can hold tens of thousands of samples
    let lo = Infinity;
    let hi = -Infinity;
    for (const a of v) {
      if (a < lo) lo = a;
      if (a > hi) hi = a;
    }
    if (!v.length) [lo, hi] = [-1, 1];
    if (hi - lo < 1e-12) [lo, hi] = [lo - 1, hi + 1];
    const m = (hi - lo) * 0.05;
    return [lo - m, hi + m] as const;
  };
  const [x0, x1] = range(xs);
  const [y0, y1] = range(ys);
  const px = (v: number) => pad.l + ((v - x0) / (x1 - x0)) * pw;
  const py = (v: number) => pad.t + ph - ((v - y0) / (y1 - y0)) * ph;

  g.strokeStyle = c.grid;
  g.fillStyle = c.muted;
  g.lineWidth = 1;
  g.textAlign = "center";
  for (const v of niceTicks(x0, x1)) {
    g.beginPath();
    g.moveTo(px(v), pad.t);
    g.lineTo(px(v), pad.t + ph);
    g.stroke();
    g.fillText(String(v), px(v), pad.t + ph + 14);
  }
  g.textAlign = "right";
  for (const v of niceTicks(y0, y1)) {
    g.beginPath();
    g.moveTo(pad.l, py(v));
    g.lineTo(pad.l + pw, py(v));
    g.stroke();
    g.fillText(String(v), pad.l - 6, py(v) + 4);
  }
  g.fillStyle = c.fg;
  g.textAlign = "center";
  g.fillText(xLabel, pad.l + pw / 2, h - 6);
  g.save();
  g.translate(12, pad.t + ph / 2);
  g.rotate(-Math.PI / 2);
  g.fillText(yLabel, 0, 0);
  g.restore();

  if (!xs.length) return;
  g.strokeStyle = c.line;
  g.lineWidth = 1.25;
  g.beginPath();
  g.moveTo(px(xs[0]!), py(ys[0]!));
  for (let i = 1; i < xs.length; i++) g.lineTo(px(xs[i]!), py(ys[i]!));
  g.stroke();
  // newest point
  g.fillStyle = c.line;
  g.beginPath();
  g.arc(px(xs.at(-1)!), py(ys.at(-1)!), 3.5, 0, 2 * Math.PI);
  g.fill();
}
