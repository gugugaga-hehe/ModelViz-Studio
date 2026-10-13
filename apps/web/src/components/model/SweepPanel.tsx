import type { SweepAxis, SweepResult } from "@modelviz/protocol";
import { Play, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { client, useProgress, useSession } from "../../state/session";
import { Heatmap } from "./Heatmap";
import { SeriesPlot } from "./SeriesPlot";

const METRICS = {
  step: ["overshootPercent", "riseTimeS", "settlingTimeS", "peakTimeS", "finalValue"],
  frequency: ["bandwidthHz", "dcGainDb", "peakGainDb", "peakHz"],
  loop: ["phaseMarginDeg", "gainMarginDb", "gainCrossoverHz", "phaseCrossoverHz"],
} as const;
type Group = keyof typeof METRICS;

interface AxisState {
  block: string;
  parameter: string;
  from: string;
  to: string;
  steps: string;
  scale: "linear" | "log";
}

export function SweepPanel({ system }: { system: string | null }) {
  const { t } = useTranslation();
  const systems = useSession((s) => s.systems);
  const [selected, setSelected] = useState(system ?? "");
  useEffect(() => {
    if (system) setSelected(system);
  }, [system]);
  const current = selected || systems[0]?.path || "";
  const info = systems.find((s) => s.path === current);
  const params = info?.parameters ?? {};
  const firstBlock = Object.keys(params)[0] ?? "";
  const axisFor = (block: string, idx: number): AxisState => {
    const names = Object.keys(params[block] ?? {});
    const name = names[Math.min(idx, names.length - 1)] ?? "";
    const spec = params[block]?.[name];
    const d = spec?.default ?? 1;
    return {
      block,
      parameter: name,
      from: String(spec?.min ?? d / 2),
      to: String(spec?.max ?? d * 2),
      steps: "10",
      scale: "linear",
    };
  };
  const [a1, setA1] = useState<AxisState>(() => axisFor(firstBlock, 0));
  const [a2, setA2] = useState<AxisState | null>(null);
  const [metric, setMetric] = useState<string>("overshootPercent");
  const [output, setOutput] = useState("");
  const [loopAt, setLoopAt] = useState("");
  const [duration, setDuration] = useState("1");
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<SweepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const progress = useProgress((s) => (jobId ? s[jobId] : undefined));

  useEffect(() => {
    setA1(axisFor(firstBlock, 0));
    setA2(null);
    setOutput(info?.outputs[0] ?? "");
    setLoopAt(info?.ports.find((p) => p.startsWith("plant.")) ?? info?.ports[0] ?? "");
    setResult(null);
  }, [current, systems]);

  const group = (Object.keys(METRICS) as Group[]).find((g) => (METRICS[g] as readonly string[]).includes(metric))!;
  const toAxis = (a: AxisState): SweepAxis => ({
    block: a.block,
    parameter: a.parameter,
    from: Number(a.from),
    to: Number(a.to),
    steps: Number(a.steps),
    scale: a.scale,
  });

  async function run(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const id = crypto.randomUUID();
    setJobId(id);
    try {
      setResult(
        await client.request("analysis.sweep", {
          id,
          system: current,
          axes: a2 ? [toAxis(a1), toAxis(a2)] : [toAxis(a1)],
          metrics: {
            output: output || info?.outputs[0] || "",
            [group]: [metric],
            ...(group === "loop" ? { openLoopAt: loopAt } : {}),
            durationS: Number(duration),
          },
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setJobId(null);
    }
  }

  const input = "rounded border border-border bg-surface px-2 py-1 text-xs";
  const axisRow = (a: AxisState, set: (a: AxisState) => void, label: string) => (
    <fieldset className="flex flex-wrap items-end gap-2" aria-label={label}>
      <legend className="sr-only">{label}</legend>
      <span className="w-12 pb-1 text-muted">{label}</span>
      <select aria-label={`${label} ${t("sweep.block")}`} className={input} value={a.block} onChange={(e) => set(axisFor(e.target.value, 0))}>
        {Object.keys(params).map((b) => (
          <option key={b}>{b}</option>
        ))}
      </select>
      <select aria-label={`${label} ${t("sweep.parameter")}`} className={input} value={a.parameter} onChange={(e) => set({ ...axisFor(a.block, Object.keys(params[a.block] ?? {}).indexOf(e.target.value)) })}>
        {Object.keys(params[a.block] ?? {}).map((p) => (
          <option key={p}>{p}</option>
        ))}
      </select>
      {(["from", "to", "steps"] as const).map((k) => (
        <input key={k} aria-label={`${label} ${t(`sweep.${k}`)}`} placeholder={t(`sweep.${k}`)} className={`${input} w-16`} value={a[k]} onChange={(e) => set({ ...a, [k]: e.target.value })} inputMode="decimal" />
      ))}
      <select aria-label={`${label} ${t("sweep.scale")}`} className={input} value={a.scale} onChange={(e) => set({ ...a, scale: e.target.value as "linear" | "log" })}>
        <option value="linear">{t("sweep.linear")}</option>
        <option value="log">{t("sweep.log")}</option>
      </select>
    </fieldset>
  );

  const values = result ? result.values[metric] : undefined;
  return (
    <section aria-label={t("sweep.title")} className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-auto text-xs" data-testid="sweep-panel">
      <form onSubmit={run} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            {t("analysis.system")}
            <select aria-label={t("analysis.system")} className={input} value={current} onChange={(e) => setSelected(e.target.value)}>
              {systems.map((s) => (
                <option key={s.path} value={s.path}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            {t("sweep.metric")}
            <select aria-label={t("sweep.metric")} className={input} value={metric} onChange={(e) => setMetric(e.target.value)}>
              {(Object.keys(METRICS) as Group[]).map((g) => (
                <optgroup key={g} label={t(`sweep.group.${g}`)}>
                  {METRICS[g].map((m) => (
                    <option key={m} value={m}>
                      {t(`sweep.m.${m}`)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          {group !== "loop" ? (
            <label className="flex flex-col gap-1">
              {t("sweep.output")}
              <select aria-label={t("sweep.output")} className={input} value={output} onChange={(e) => setOutput(e.target.value)}>
                {(info?.outputs ?? []).map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </label>
          ) : (
            <label className="flex flex-col gap-1">
              {t("analysis.loopAt")}
              <select aria-label={t("analysis.loopAt")} className={input} value={loopAt} onChange={(e) => setLoopAt(e.target.value)}>
                {(info?.ports ?? []).map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
          )}
          {group === "step" && (
            <label className="flex w-20 flex-col gap-1">
              {t("analysis.duration")}
              <input aria-label={t("analysis.duration")} className={input} value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="decimal" />
            </label>
          )}
        </div>
        {axisRow(a1, setA1, t("sweep.axis1"))}
        {a2 ? (
          <div className="flex items-end gap-2">
            {axisRow(a2, setA2, t("sweep.axis2"))}
            <button type="button" onClick={() => setA2(null)} aria-label={t("sweep.removeAxis")} className="pb-1 text-muted hover:text-fg">
              <X size={14} />
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setA2(axisFor(Object.keys(params).at(-1) ?? firstBlock, 1))} className="self-start text-muted hover:text-fg" disabled={!firstBlock}>
            + {t("sweep.addAxis")}
          </button>
        )}
        <div className="flex items-center gap-2">
          <button type="submit" disabled={!firstBlock || jobId !== null} className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 font-medium text-white disabled:opacity-40">
            <Play size={12} />
            {t("sweep.run")}
          </button>
          {jobId && (
            <>
              <progress className="h-2 w-48" max={progress?.total ?? 1} value={progress?.done ?? 0} aria-label={t("sweep.progress")} />
              <span className="tabular-nums" data-testid="sweep-progress">
                {progress ? `${progress.done}/${progress.total}` : "…"}
              </span>
              <button type="button" onClick={() => void client.request("analysis.cancel", { id: jobId })} className="rounded border border-border px-2 py-1">
                {t("sweep.cancel")}
              </button>
            </>
          )}
        </div>
      </form>
      {!firstBlock && <p className="text-muted">{t("sweep.noParameters")}</p>}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {result && values && result.axes.length === 1 && (
        <SeriesPlot
          testId="sweep-curve"
          x={result.axes[0]!.values}
          xLabel={`${result.axes[0]!.block}.${result.axes[0]!.parameter}`}
          logX={result.axes[0]!.scale === "log"}
          height={240}
          series={[{ label: t(`sweep.m.${metric}`), values: (values as (number | null)[]).map((v) => v ?? Number.NaN), color: "#2563eb", points: false }]}
        />
      )}
      {result && values && result.axes.length === 2 && (
        <Heatmap
          rows={result.axes[0]!.values}
          cols={result.axes[1]!.values}
          values={values as (number | null)[][]}
          rowLabel={`${result.axes[0]!.block}.${result.axes[0]!.parameter}`}
          colLabel={`${result.axes[1]!.block}.${result.axes[1]!.parameter}`}
          metric={t(`sweep.m.${metric}`)}
        />
      )}
    </section>
  );
}
