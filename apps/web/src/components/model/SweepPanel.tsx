import type { SweepAxis, SweepResult } from "@modelviz/protocol";
import { Play, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { client, useProgress, useSession } from "../../state/session";
import { seriesColor } from "../plot-theme";
import { Heatmap } from "./Heatmap";
import { SeriesPlot } from "./SeriesPlot";
import { Button, Input, Select } from "../ui/controls";

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

  const axisRow = (a: AxisState, set: (a: AxisState) => void, label: string) => (
    <fieldset className="flex flex-wrap items-end gap-2" aria-label={label}>
      <legend className="sr-only">{label}</legend>
      <span className="w-12 pb-1 text-muted">{label}</span>
      <Select aria-label={`${label} ${t("sweep.block")}`} value={a.block} onChange={(e) => set(axisFor(e.target.value, 0))}>
        {Object.keys(params).map((b) => (
          <option key={b}>{b}</option>
        ))}
      </Select>
      <Select aria-label={`${label} ${t("sweep.parameter")}`} value={a.parameter} onChange={(e) => set({ ...axisFor(a.block, Object.keys(params[a.block] ?? {}).indexOf(e.target.value)) })}>
        {Object.keys(params[a.block] ?? {}).map((p) => (
          <option key={p}>{p}</option>
        ))}
      </Select>
      {(["from", "to", "steps"] as const).map((k) => (
        <Input key={k} aria-label={`${label} ${t(`sweep.${k}`)}`} placeholder={t(`sweep.${k}`)} className="w-16" value={a[k]} onChange={(e) => set({ ...a, [k]: e.target.value })} inputMode="decimal" />
      ))}
      <Select aria-label={`${label} ${t("sweep.scale")}`} value={a.scale} onChange={(e) => set({ ...a, scale: e.target.value as "linear" | "log" })}>
        <option value="linear">{t("sweep.linear")}</option>
        <option value="log">{t("sweep.log")}</option>
      </Select>
    </fieldset>
  );

  const values = result ? result.values[metric] : undefined;
  return (
    <section aria-label={t("sweep.title")} className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-auto text-xs" data-testid="sweep-panel">
      <form onSubmit={run} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            {t("analysis.system")}
            <Select aria-label={t("analysis.system")} value={current} onChange={(e) => setSelected(e.target.value)}>
              {systems.map((s) => (
                <option key={s.path} value={s.path}>
                  {s.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            {t("sweep.metric")}
            <Select aria-label={t("sweep.metric")} value={metric} onChange={(e) => setMetric(e.target.value)}>
              {(Object.keys(METRICS) as Group[]).map((g) => (
                <optgroup key={g} label={t(`sweep.group.${g}`)}>
                  {METRICS[g].map((m) => (
                    <option key={m} value={m}>
                      {t(`sweep.m.${m}`)}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
          </label>
          {group !== "loop" ? (
            <label className="flex flex-col gap-1">
              {t("sweep.output")}
              <Select aria-label={t("sweep.output")} value={output} onChange={(e) => setOutput(e.target.value)}>
                {(info?.outputs ?? []).map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            </label>
          ) : (
            <label className="flex flex-col gap-1">
              {t("analysis.loopAt")}
              <Select aria-label={t("analysis.loopAt")} value={loopAt} onChange={(e) => setLoopAt(e.target.value)}>
                {(info?.ports ?? []).map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </Select>
            </label>
          )}
          {group === "step" && (
            <label className="flex w-20 flex-col gap-1">
              {t("analysis.duration")}
              <Input aria-label={t("analysis.duration")} value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="decimal" />
            </label>
          )}
        </div>
        {axisRow(a1, setA1, t("sweep.axis1"))}
        {a2 ? (
          <div className="flex items-end gap-2">
            {axisRow(a2, setA2, t("sweep.axis2"))}
            <Button type="button" onClick={() => setA2(null)} aria-label={t("sweep.removeAxis")} variant="subtle" size="inline" className="pb-1">
              <X size={14} />
            </Button>
          </div>
        ) : (
          <Button type="button" onClick={() => setA2(axisFor(Object.keys(params).at(-1) ?? firstBlock, 1))} variant="subtle" size="inline" className="self-start" disabled={!firstBlock}>
            + {t("sweep.addAxis")}
          </Button>
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!firstBlock || jobId !== null} variant="primary" size="md">
            <Play size={12} />
            {t("sweep.run")}
          </Button>
          {jobId && (
            <>
              <progress className="h-2 w-48" max={progress?.total ?? 1} value={progress?.done ?? 0} aria-label={t("sweep.progress")} />
              <span className="tabular-nums" data-testid="sweep-progress">
                {progress ? `${progress.done}/${progress.total}` : "…"}
              </span>
              <Button type="button" onClick={() => void client.request("analysis.cancel", { id: jobId })} >
                {t("sweep.cancel")}
              </Button>
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
          series={[{ label: t(`sweep.m.${metric}`), values: (values as (number | null)[]).map((v) => v ?? Number.NaN), color: seriesColor(0), points: false }]}
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
