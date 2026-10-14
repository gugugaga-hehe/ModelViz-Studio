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
