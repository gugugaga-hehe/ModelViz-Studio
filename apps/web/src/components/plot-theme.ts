import { useSyncExternalStore } from "react";

/**
 * Colours for canvas plots. Canvas cannot use CSS variables, so plots resolve the `--mv-*` tokens
 * from index.css when they are created, and are recreated when the colour scheme changes.
 */
export interface PlotTheme {
  /** Axis labels and ticks. */
  axis: string;
  grid: string;
  fg: string;
  accent: string;
}

/** Number of distinct series colours (`--mv-series-1` … `--mv-series-8`). */
export const SERIES_COLORS = 8;

/** The i-th series colour as a CSS reference; resolve it with `resolveColor` for canvas. */
export function seriesColor(i: number): string {
  return `var(--mv-series-${(i % SERIES_COLORS) + 1})`;
}

/** Colour of reference/input series (e.g. the step a System is driven with). */
export const REFERENCE_COLOR = "var(--mv-series-ref)";
/** Colour for overlays drawn in the text colour (e.g. a loop transfer). */
export const FOREGROUND_COLOR = "var(--mv-fg)";

/** A colour usable on canvas: `var(--token)` becomes the token's current value. */
export function resolveColor(color: string): string {
  const m = /^var\((--[\w-]+)\)$/.exec(color);
  return m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]!).trim() : color;
}

/** Sequential ramp (dark blue → teal → yellow) for heatmaps; readable on light and dark backgrounds. */
const SEQUENTIAL: [number, number, number][] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];

/** Colour of a value at position t ∈ [0, 1] of a heatmap's range. */
export function sequentialColor(t: number): string {
  const x = Math.min(1, Math.max(0, t)) * (SEQUENTIAL.length - 1);
  const i = Math.min(SEQUENTIAL.length - 2, Math.floor(x));
  const f = x - i;
  const [a, b] = [SEQUENTIAL[i]!, SEQUENTIAL[i + 1]!];
  return `rgb(${a.map((v, k) => Math.round(v + (b[k]! - v) * f)).join(",")})`;
}

/** The sequential ramp as CSS gradient stops (for legends). */
export const SEQUENTIAL_GRADIENT = SEQUENTIAL.map((_, k) => sequentialColor(k / (SEQUENTIAL.length - 1))).join(",");

/** Heatmap cells without a value. */
export const MISSING_COLOR = "rgba(128,128,128,0.25)";

function readTheme(): PlotTheme {
  return {
    axis: resolveColor("var(--mv-muted)"),
    grid: resolveColor("var(--mv-border)"),
    fg: resolveColor("var(--mv-fg)"),
    accent: resolveColor("var(--mv-accent)"),
  };
}

const scheme = window.matchMedia("(prefers-color-scheme: dark)");
let current: PlotTheme | null = null;

function subscribe(onChange: () => void): () => void {
  const changed = () => {
    current = readTheme();
    onChange();
  };
  scheme.addEventListener("change", changed);
  return () => scheme.removeEventListener("change", changed);
}

function snapshot(): PlotTheme {
  return (current ??= readTheme());
}

/** The current plot colours; components re-render (and should recreate plots) when they change. */
export function usePlotTheme(): PlotTheme {
  return useSyncExternalStore(subscribe, snapshot);
}
