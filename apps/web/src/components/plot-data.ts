import uPlot from "uplot";
import type { SignalBuffer } from "../state/signal-store";

/**
 * Builds uPlot data for several Signals since `fromMs`. Signals decoded from the same Message
 * share timestamps exactly, so the common case skips the (costly) union-join.
 */
export function alignedSince(buffers: SignalBuffer[], fromMs: number): uPlot.AlignedData {
  const tables = buffers.map((b) => b.since(fromMs));
  if (tables.length === 0) return [[]];
  const [first] = tables;
  const sameX = tables.every(
    ([xs]) => xs.length === first![0].length && xs[0] === first![0][0] && xs[xs.length - 1] === first![0][first![0].length - 1],
  );
  if (sameX) return [first![0], ...tables.map(([, ys]) => ys)];
  return uPlot.join(tables as uPlot.AlignedData[]);
}

/** Mouse-wheel zoom around the cursor and Shift+drag pan on the x axis. */
export function wheelZoomPanPlugin(onUserRange: () => void): uPlot.Plugin {
  return {
    hooks: {
      ready: (u) => {
        const over = u.over;
        over.addEventListener(
          "wheel",
          (e) => {
            e.preventDefault();
            const { min, max } = u.scales.x!;
            if (min === undefined || max === undefined) return;
            const at = u.posToVal(e.offsetX, "x");
            const factor = e.deltaY < 0 ? 0.8 : 1.25;
            onUserRange();
            u.setScale("x", { min: at - (at - min) * factor, max: at + (max - at) * factor });
          },
          { passive: false },
        );
        over.addEventListener("mousedown", (e) => {
          if (!e.shiftKey) return;
          e.preventDefault();
          e.stopPropagation();
          const { min, max } = u.scales.x!;
          if (min === undefined || max === undefined) return;
          const startX = e.clientX;
          const perPx = (max - min) / u.bbox.width * devicePixelRatio;
          onUserRange();
          const move = (ev: MouseEvent) => {
            const d = (ev.clientX - startX) * perPx;
            u.setScale("x", { min: min - d, max: max - d });
          };
          const up = () => {
            window.removeEventListener("mousemove", move);
            window.removeEventListener("mouseup", up);
          };
          window.addEventListener("mousemove", move);
          window.addEventListener("mouseup", up);
        }, true);
      },
    },
  };
}

/**
 * (x, y) pairs of two Signals since `fromMs`: each y sample is paired with the latest x sample
 * at or before it (sample-and-hold), so Signals from different Messages can be plotted together.
 */
export function pairsSince(x: SignalBuffer, y: SignalBuffer, fromMs: number): { xs: number[]; ys: number[] } {
  // look back further for x, so the first y samples have an x to hold
  const [xt, xv] = x.since(fromMs - 1000);
  const [yt, yv] = y.since(fromMs);
  const xs: number[] = [];
  const ys: number[] = [];
  let j = -1;
  for (let i = 0; i < yt.length; i++) {
    while (j + 1 < xt.length && xt[j + 1]! <= yt[i]!) j++;
    if (j < 0) continue;
    xs.push(xv[j]!);
    ys.push(yv[i]!);
  }
  return { xs, ys };
}

/** About `count` round tick values covering [min, max]. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}
