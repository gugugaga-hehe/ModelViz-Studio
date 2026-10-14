import type { Stimulus, TimeAnalysisResult } from "@modelviz/protocol";
import { Play } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { client, useSession } from "../../state/session";
import { SeriesPlot } from "./SeriesPlot";

const PALETTE = ["#64748b", "#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed"];
type Kind = "step" | "impulse" | "stimulus";
type StimKind = "sine" | "chirp" | "sineSweep";

export function AnalysisPanel({ system }: { system: string | null }) {
  const { t } = useTranslation();
  const systems = useSession((s) => s.systems);
  const [selected, setSelected] = useState(system ?? "");
  const [kind, setKind] = useState<Kind>("step");
  const [stim, setStim] = useState<StimKind>("chirp");
  const [f0, setF0] = useState("1");
  const [f1, setF1] = useState("50");
  const [amp, setAmp] = useState("1");
  const [duration, setDuration] = useState("1");
  const [result, setResult] = useState<TimeAnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (system) setSelected(system);
  }, [system]);
  const current = selected || systems[0]?.path || "";

  async function run(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const stimulus: Stimulus =
      stim === "sine"
        ? { kind: "sine", freqHz: Number(f0), amplitude: Number(amp) }
        : { kind: stim, f0Hz: Number(f0), f1Hz: Number(f1), amplitude: Number(amp) };
    try {
      setResult(
        await client.request("analysis.time", {
          system: current,
          kind,
          durationS: Number(duration),
          ...(kind === "stimulus" ? { stimulus } : {}),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const input = "rounded border border-border bg-surface px-2 py-1 text-xs";
  return (
    <section aria-label={t("analysis.title")} className="flex min-h-0 flex-1 flex-col gap-2" data-testid="analysis-panel">
      <form onSubmit={run} className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">
          {t("analysis.system")}
          <select className={input} value={current} onChange={(e) => setSelected(e.target.value)}>
            {systems.map((s) => (
              <option key={s.path} value={s.path}>
                {s.name}
                {s.issues.length ? " ⚠" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          {t("analysis.kind")}
          <select className={input} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="step">{t("analysis.step")}</option>
            <option value="impulse">{t("analysis.impulse")}</option>
            <option value="stimulus">{t("analysis.stimulus")}</option>
          </select>
        </label>
        {kind === "stimulus" && (
          <>
            <label className="flex flex-col gap-1">
              Stimulus
              <select className={input} value={stim} onChange={(e) => setStim(e.target.value as StimKind)}>
                <option value="chirp">chirp</option>
                <option value="sineSweep">sine sweep</option>
                <option value="sine">sine</option>
              </select>
            </label>
            <label className="flex w-16 flex-col gap-1">
              {stim === "sine" ? "f [Hz]" : "f0 [Hz]"}
              <input className={input} value={f0} onChange={(e) => setF0(e.target.value)} inputMode="decimal" />
            </label>
            {stim !== "sine" && (
              <label className="flex w-16 flex-col gap-1">
                f1 [Hz]
                <input className={input} value={f1} onChange={(e) => setF1(e.target.value)} inputMode="decimal" />
              </label>
            )}
            <label className="flex w-16 flex-col gap-1">
              {t("analysis.amplitude")}
              <input className={input} value={amp} onChange={(e) => setAmp(e.target.value)} inputMode="decimal" />
            </label>
          </>
        )}
        <label className="flex w-20 flex-col gap-1">
          {t("analysis.duration")}
          <input className={input} value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="decimal" />
        </label>
        <button type="submit" disabled={!current || busy} className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40">
          <Play size={12} />
          {t("analysis.run")}
        </button>
      </form>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <ResultPlot result={result} />
    </section>
  );
}

function ResultPlot({ result }: { result: TimeAnalysisResult | null }) {
  const series = useMemo(
    () =>
      result
        ? Object.keys(result.series).map((n, i) => ({
            label: n,
            values: result.series[n]!,
            color: PALETTE[i % PALETTE.length]!,
            dashed: n === result.input,
          }))
        : [],
    [result],
  );
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-testid="analysis-result"
      data-points={result?.times.length ?? 0}
      data-final={result ? JSON.stringify(Object.fromEntries(Object.entries(result.series).map(([k, v]) => [k, v.at(-1)]))) : ""}
    >
      {result && <SeriesPlot x={result.times} series={series} />}
    </div>
  );
}
