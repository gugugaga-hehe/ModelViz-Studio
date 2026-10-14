import { SPECTRUM_LENGTHS, type SignalInfo, type SpectrumResult, type SpectrumWindow } from "@modelviz/protocol";
import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import { client, signalStore } from "../../state/session";
import { useRetained } from "../TimePlotPanel";
import { SignalSelect, useSignalsById } from "./SignalPicker";

export type SpectrumScale = "amplitude" | "psd";
export interface SpectrumSettings {
  signal: string;
  window: SpectrumWindow;
  length: number;
  scale: SpectrumScale;
  db: boolean;
}

const WINDOWS: SpectrumWindow[] = ["hann", "hamming", "blackman", "flattop", "rectangular"];
/** Spectra are recomputed at most this often while data arrives. */
const REFRESH_MS = 500;

/** FFT/PSD of the newest samples of any Signal: telemetry, Log Replay or model output. */
export function SpectrumPanel({ n, settings, onChange }: { n: number; settings: SpectrumSettings; onChange: (s: Partial<SpectrumSettings>) => void }) {
  const { t } = useTranslation();
  const signals = useSignalsById(settings.signal ? [settings.signal] : []);
  useRetained(signals);
  const [held, setHeld] = useState(false);
  const title = t("panels.fftTitle", { n });
  const select = "rounded border border-border bg-surface px-2 py-1 text-sm text-fg";
  const label = "flex flex-col gap-1 text-xs text-muted";
  return (
    <section aria-label={title} data-testid={`spectrum-panel-${n - 1}`} className="@container h-full min-h-0 bg-surface p-3">
      <div className="flex h-full min-h-0 flex-col gap-3 @[36rem]:flex-row">
        <div className="flex max-h-40 shrink-0 flex-col gap-2 overflow-auto @[36rem]:max-h-none @[36rem]:w-60">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
            <button
              onClick={() => setHeld((h) => !h)}
              disabled={!signals.length}
              className="ml-auto inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-xs disabled:opacity-40"
            >
              {held ? <Play size={12} /> : <Pause size={12} />}
              {t(held ? "plot.resume" : "panels.hold")}
            </button>
          </div>
          <SignalSelect label={t("panels.signal")} value={settings.signal} onChange={(signal) => onChange({ signal })} />
          <label className={label}>
            {t("panels.window")}
            <select aria-label={t("panels.window")} className={select} value={settings.window} onChange={(e) => onChange({ window: e.target.value as SpectrumWindow })}>
              {WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {t(`panels.windows.${w}`)}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t("panels.length")}
            <select aria-label={t("panels.length")} className={select} value={settings.length} onChange={(e) => onChange({ length: Number(e.target.value) })}>
              {SPECTRUM_LENGTHS.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t("panels.scale")}
            <select aria-label={t("panels.scale")} className={select} value={settings.scale} onChange={(e) => onChange({ scale: e.target.value as SpectrumScale })}>
              <option value="amplitude">{t("panels.scales.amplitude")}</option>
              <option value="psd">{t("panels.scales.psd")}</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={settings.db} onChange={(e) => onChange({ db: e.target.checked })} />
            {t("panels.db")}
          </label>
        </div>
        {signals[0] ? (
          <SpectrumPlot signal={signals[0]} settings={settings} held={held} />
        ) : (
          <div className="flex min-h-40 min-w-0 flex-1 items-center justify-center text-sm text-muted">{t("panels.pickSpectrum")}</div>
        )}
      </div>
    </section>
  );
}

function SpectrumPlot({ signal, settings, held }: { signal: SignalInfo; settings: SpectrumSettings; held: boolean }) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const heldRef = useRef(held);
  heldRef.current = held;
  const [result, setResult] = useState<SpectrumResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // recompute from the newest samples while data arrives (one request in flight at a time)
  useEffect(() => {
    setResult(null);
    setError(null);
    let busy = false;
    let lastReceived = -1;
    let stopped = false;
    const tick = async () => {
      const b = signalStore.buffer(signal.handle);
      // on hold, still compute once after a settings change
      if (busy || (heldRef.current && lastReceived >= 0) || b.received === lastReceived || b.length < 16) return;
      busy = true;
      lastReceived = b.received;
      const { times, values } = b.newest(settings.length);
      try {
        const r = await client.request("analysis.spectrum", { times, values, window: settings.window, length: settings.length });
        if (!stopped) {
          setResult(r);
          setError(null);
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [signal, settings.window, settings.length]);

  // dimensionless Signals read "Amplitude [1]", "PSD [1²/Hz]"
  const units = signal.units || "1";
  const yLabel =
    settings.scale === "amplitude"
      ? settings.db ? t("panels.axis.amplitudeDb", { units }) : t("panels.axis.amplitude", { units })
      : settings.db ? t("panels.axis.psdDb", { units }) : t("panels.axis.psd", { units });

  const plotRef = useRef<uPlot | null>(null);

  // one plot per Signal and scale; new spectra only replace its data
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const css = getComputedStyle(document.documentElement);
    const muted = css.getPropertyValue("--mv-muted").trim();
    const grid = css.getPropertyValue("--mv-border").trim();
    const plot = new uPlot(
      {
        width: el.clientWidth,
        height: Math.max(140, el.clientHeight - 30),
        scales: { x: { time: false } },
        series: [{ label: "Hz" }, { label: signal.id, stroke: css.getPropertyValue("--mv-accent").trim(), width: 1.25, points: { show: false } }],
        axes: [
          { stroke: muted, grid: { stroke: grid }, label: t("panels.axis.frequency") },
          { stroke: muted, grid: { stroke: grid }, label: yLabel, size: 60 },
        ],
        legend: { show: false },
        cursor: { drag: { x: true, y: false, setScale: true } },
      },
      [[], []],
      el,
    );
    plotRef.current = plot;
    const resize = new ResizeObserver(() => plot.setSize({ width: el.clientWidth, height: Math.max(140, el.clientHeight - 30) }));
    resize.observe(el);
    return () => {
      resize.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [signal, yLabel, t]);

  useEffect(() => {
    const plot = plotRef.current;
    if (!plot || !result) return;
    const raw = settings.scale === "amplitude" ? result.amplitude : result.psd;
    // dB of amplitude is 20·log10, of power 10·log10; the floor keeps empty bins finite
    const y = settings.db ? raw.map((v) => (settings.scale === "amplitude" ? 20 : 10) * Math.log10(Math.max(v, 1e-12))) : raw;
    plot.setData([result.frequencies, y]);
  }, [result, settings.scale, settings.db, yLabel]);

  // strongest component above DC, for a quick reading
  let peak = -1;
  if (result) for (let k = 1; k < result.amplitude.length; k++) if (peak < 0 || result.amplitude[k]! > result.amplitude[peak]!) peak = k;

  return (
    <div
      className="flex min-h-40 min-w-0 flex-1 flex-col"
      data-testid="spectrum"
      data-window={result?.window ?? ""}
      data-length={result?.length ?? ""}
      data-bins={result?.frequencies.length ?? 0}
      data-peak-hz={peak > 0 ? result!.frequencies[peak] : ""}
    >
      <div className="text-xs text-muted" data-testid="spectrum-info">
        {error ? (
          <span className="text-danger">{error}</span>
        ) : result ? (
          t("panels.spectrumInfo", {
            fs: result.sampleRateHz.toFixed(1),
            samples: result.samples,
            length: result.length,
            res: result.resolutionHz.toPrecision(3),
            peakHz: peak > 0 ? result.frequencies[peak]!.toPrecision(4) : "—",
            peak: peak > 0 ? result.amplitude[peak]!.toPrecision(3) : "—",
          })
        ) : (
          t("panels.collecting")
        )}
      </div>
      <div ref={host} className="min-h-0 flex-1" />
    </div>
  );
}
