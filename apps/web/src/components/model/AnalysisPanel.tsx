import type { FrequencyAnalysisResult, PoleZeroResult, Stimulus, TimeAnalysisResult } from "@modelviz/protocol";
import { Play } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { client, useProgress, useSession } from "../../state/session";
import { MetricsTable } from "./MetricsTable";
import { PoleZeroPlot } from "./PoleZeroPlot";
import { type Series, SeriesPlot } from "./SeriesPlot";

/** Foreground colour of the current theme (canvas cannot read CSS variables). */
const fg = () => getComputedStyle(document.documentElement).getPropertyValue("--mv-fg").trim() || "#111827";

const PALETTE = ["#64748b", "#2563eb", "#dc2626", "#16a34a", "#d97706", "#7c3aed"];
type Kind = "step" | "impulse" | "stimulus" | "bode" | "polezero";
type StimKind = "sine" | "chirp" | "sineSweep";
type Result =
  | { kind: "time"; data: TimeAnalysisResult }
  | { kind: "bode"; data: FrequencyAnalysisResult }
  | { kind: "polezero"; data: PoleZeroResult };

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
  const [loopAt, setLoopAt] = useState("");
  const [method, setMethod] = useState<"auto" | "analytic" | "measured">("auto");
  const [mAmp, setMAmp] = useState("1");
  const [jobId, setJobId] = useState<string | null>(null);
  const progress = useProgress((s) => (jobId ? s[jobId] : undefined));
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (system) setSelected(system);
  }, [system]);
  const current = selected || systems[0]?.path || "";
  const info = systems.find((s) => s.path === current);

  async function run(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (kind === "bode") {
        const id = crypto.randomUUID();
        setJobId(id);
        setResult({
          kind: "bode",
          data: await client.request("analysis.frequency", {
            system: current,
            method,
            amplitude: Number(mAmp),
            id,
            ...(loopAt ? { openLoopAt: loopAt } : {}),
          }),
        });
      } else if (kind === "polezero") {
        setResult({ kind: "polezero", data: await client.request("analysis.poleZero", { system: current }) });
      } else {
        const stimulus: Stimulus =
          stim === "sine"
            ? { kind: "sine", freqHz: Number(f0), amplitude: Number(amp) }
            : { kind: stim, f0Hz: Number(f0), f1Hz: Number(f1), amplitude: Number(amp) };
        setResult({
          kind: "time",
          data: await client.request("analysis.time", {
            system: current,
            kind,
            durationS: Number(duration),
            ...(kind === "stimulus" ? { stimulus } : {}),
          }),
        });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      setJobId(null);
    }
  }

  const input = "rounded border border-border bg-surface px-2 py-1 text-xs";
  const timeKind = kind === "step" || kind === "impulse" || kind === "stimulus";
  return (
    <section aria-label={t("analysis.title")} className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-auto" data-testid="analysis-panel">
      <form onSubmit={run} className="flex flex-wrap items-end gap-2 text-xs">
        <label className="flex flex-col gap-1">
          {t("analysis.system")}
          <select aria-label={t("analysis.system")} className={input} value={current} onChange={(e) => setSelected(e.target.value)}>
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
          <select aria-label={t("analysis.kind")} className={input} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="step">{t("analysis.step")}</option>
            <option value="impulse">{t("analysis.impulse")}</option>
            <option value="stimulus">{t("analysis.stimulus")}</option>
            <option value="bode">{t("analysis.bode")}</option>
            <option value="polezero">{t("analysis.polezero")}</option>
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
        {timeKind && (
          <label className="flex w-20 flex-col gap-1">
            {t("analysis.duration")}
            <input aria-label={t("analysis.duration")} className={input} value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="decimal" />
          </label>
        )}
        {kind === "bode" && (
          <label className="flex flex-col gap-1">
            {t("analysis.methodLabel")}
            <select aria-label={t("analysis.methodLabel")} className={input} value={method} onChange={(e) => setMethod(e.target.value as typeof method)}>
              <option value="auto">{t("analysis.methodAuto", { method: t(info?.linear ? "analysis.method.analytic" : "analysis.method.measured") })}</option>
              <option value="analytic">{t("analysis.method.analytic")}</option>
              <option value="measured">{t("analysis.method.measured")}</option>
            </select>
          </label>
        )}
        {kind === "bode" && (method === "measured" || (method === "auto" && info && !info.linear)) && (
          <label className="flex w-20 flex-col gap-1">
            {t("analysis.amplitude")}
            <input aria-label={t("analysis.measureAmplitude")} className={input} value={mAmp} onChange={(e) => setMAmp(e.target.value)} inputMode="decimal" />
          </label>
        )}
        {kind === "bode" && (
          <label className="flex flex-col gap-1">
            {t("analysis.loopAt")}
            <select aria-label={t("analysis.loopAt")} className={input} value={loopAt} onChange={(e) => setLoopAt(e.target.value)}>
              <option value="">{t("analysis.closedOnly")}</option>
              {(info?.ports ?? []).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" disabled={!current || busy} className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40">
          <Play size={12} />
          {t("analysis.run")}
        </button>
        {jobId && progress && (
          <>
            <progress className="h-2 w-32" max={progress.total} value={progress.done} aria-label={t("sweep.progress")} />
            <button type="button" onClick={() => void client.request("analysis.cancel", { id: jobId })} className="rounded border border-border px-2 py-1">
              {t("sweep.cancel")}
            </button>
          </>
        )}
      </form>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      {result?.kind === "time" && <TimeResult result={result.data} />}
      {result?.kind === "bode" && <BodeResult result={result.data} />}
      {result?.kind === "polezero" && <PoleZeroView result={result.data} />}
    </section>
  );
}

function TimeResult({ result }: { result: TimeAnalysisResult }) {
  const { t } = useTranslation();
  const series = useMemo(
    () =>
      Object.keys(result.series).map((n, i) => ({
        label: n,
        values: result.series[n]!,
        color: PALETTE[i % PALETTE.length]!,
        dashed: n === result.input,
      })),
    [result],
  );
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-2"
      data-testid="analysis-result"
      data-points={result.times.length}
      data-final={JSON.stringify(Object.fromEntries(Object.entries(result.series).map(([k, v]) => [k, v.at(-1)])))}
    >
      <SeriesPlot x={result.times} series={series} />
      {result.metrics && (
        <MetricsTable
          testId="step-metrics"
          rows={result.metrics}
          columns={[
            { key: "finalValue", label: t("metrics.final") },
            { key: "overshootPercent", label: t("metrics.overshoot") },
            { key: "riseTimeS", label: t("metrics.rise") },
            { key: "settlingTimeS", label: t("metrics.settling") },
            { key: "peakTimeS", label: t("metrics.peakTime") },
          ]}
        />
      )}
    </div>
  );
}

function BodeResult({ result }: { result: FrequencyAnalysisResult }) {
  const { t } = useTranslation();
  const names = Object.keys(result.responses);
  const build = (pick: "magnitudeDb" | "phaseDeg"): Series[] => {
    const s: Series[] = names.map((n, i) => ({ label: n, values: result.responses[n]![pick], color: PALETTE[(i + 1) % PALETTE.length]! }));
    if (result.loop) s.push({ label: `L @ ${result.loop.at}`, values: result.loop[pick], color: fg(), dashed: true });
    return s;
  };
  const mag = useMemo(() => build("magnitudeDb"), [result]);
  const phase = useMemo(() => build("phaseDeg"), [result]);
  return (
    <div className="flex flex-col gap-2" data-testid="bode-result" data-method={result.method} data-points={result.frequencies.length}>
      <p className="text-xs text-muted">
        {t(`analysis.method.${result.method}`)} · {t(`analysis.domain.${result.domain}`)}
      </p>
      <SeriesPlot x={result.frequencies} series={mag} logX xLabel="f [Hz]" height={200} testId="bode-magnitude" />
      <SeriesPlot x={result.frequencies} series={phase} logX xLabel="f [Hz]" height={180} testId="bode-phase" />
      <MetricsTable
        testId="frequency-metrics"
        rows={result.metrics}
        columns={[
          { key: "dcGainDb", label: t("metrics.dcGain") },
          { key: "bandwidthHz", label: t("metrics.bandwidth") },
          { key: "peakGainDb", label: t("metrics.peakGain") },
          { key: "peakHz", label: t("metrics.peakHz") },
        ]}
      />
      {result.loop && (
        <MetricsTable
          testId="loop-metrics"
          rows={{ [`L @ ${result.loop.at}`]: result.loop as unknown as Record<string, number | null> }}
          columns={[
            { key: "gainMarginDb", label: t("metrics.gainMargin") },
            { key: "phaseCrossoverHz", label: t("metrics.phaseCrossover") },
            { key: "phaseMarginDeg", label: t("metrics.phaseMargin") },
            { key: "gainCrossoverHz", label: t("metrics.gainCrossover") },
          ]}
        />
      )}
    </div>
  );
}

function PoleZeroView({ result }: { result: PoleZeroResult }) {
  const { t } = useTranslation();
  const outputs = Object.keys(result.zeros);
  const [output, setOutput] = useState(outputs[0] ?? "");
  return (
    <div className="flex flex-wrap items-start gap-4">
      <PoleZeroPlot result={result} output={output} />
      <div className="flex flex-col gap-2 text-xs">
        <label className="flex flex-col gap-1">
          {t("pz.zerosOf")}
          <select className="rounded border border-border bg-surface px-2 py-1" value={output} onChange={(e) => setOutput(e.target.value)}>
            {outputs.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        <div>
          <div className="text-muted">{t("pz.poles")}</div>
          <ul className="font-mono" data-testid="pole-list">
            {result.poles.map((p, i) => (
              <li key={i}>{fmtC(p)}</li>
            ))}
          </ul>
        </div>
        <div>
          <div className="text-muted">{t("pz.zeros")}</div>
          <ul className="font-mono">
            {(result.zeros[output] ?? []).map((p, i) => (
              <li key={i}>{fmtC(p)}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function fmtC(c: { re: number; im: number }): string {
  const r = Number(c.re.toPrecision(5));
  const i = Number(Math.abs(c.im).toPrecision(5));
  return i === 0 ? `${r}` : `${r} ${c.im < 0 ? "−" : "+"} ${i}j`;
}
