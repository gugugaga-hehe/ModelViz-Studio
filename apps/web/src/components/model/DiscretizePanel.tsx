import type { DiscretizationComparison } from "@modelviz/protocol";
import { GitCompare, Save } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { client, refreshModels } from "../../state/session";
import { seriesColor } from "../plot-theme";
import { SeriesPlot } from "./SeriesPlot";

/** Discretization of the open continuous Block: compare, then save as a discrete Block. */
export function DiscretizePanel({ block }: { block: string }) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<"zoh" | "tustin">("zoh");
  const [rate, setRate] = useState("1000");
  const [prewarp, setPrewarp] = useState("");
  const [kind, setKind] = useState<"step" | "impulse">("step");
  const [duration, setDuration] = useState("0.5");
  const [saveAs, setSaveAs] = useState(block.replace(/\.ya?ml$/, "-d.yaml"));
  const [cmp, setCmp] = useState<DiscretizationComparison | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const base = () => ({
    block,
    method,
    sampleRateHz: Number(rate),
    ...(method === "tustin" && prewarp ? { prewarpHz: Number(prewarp) } : {}),
  });

  async function compare() {
    setMessage(null);
    try {
      setCmp(await client.request("analysis.discretization", { ...base(), kind, durationS: Number(duration) }));
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  }

  async function save() {
    setMessage(null);
    try {
      const r = await client.request("block.discretize", { ...base(), save: saveAs });
      await refreshModels();
      setMessage({ ok: true, text: t("disc.saved", { path: r.saved }) });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  }

  const input = "rounded border border-border bg-surface px-2 py-1 text-xs";
  return (
    <section aria-label={t("disc.title")} className="flex min-h-0 flex-1 flex-col gap-2 text-xs" data-testid="discretize-panel">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          {t("disc.method")}
          <select className={input} value={method} onChange={(e) => setMethod(e.target.value as "zoh" | "tustin")}>
            <option value="zoh">ZOH</option>
            <option value="tustin">Tustin</option>
          </select>
        </label>
        <label className="flex w-24 flex-col gap-1">
          {t("disc.rate")}
          <input className={input} value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" />
        </label>
        {method === "tustin" && (
          <label className="flex w-24 flex-col gap-1">
            {t("disc.prewarp")}
            <input className={input} value={prewarp} onChange={(e) => setPrewarp(e.target.value)} inputMode="decimal" placeholder="—" />
          </label>
        )}
        <label className="flex flex-col gap-1">
          {t("analysis.kind")}
          <select className={input} value={kind} onChange={(e) => setKind(e.target.value as "step" | "impulse")}>
            <option value="step">{t("analysis.step")}</option>
            <option value="impulse">{t("analysis.impulse")}</option>
          </select>
        </label>
        <label className="flex w-20 flex-col gap-1">
          {t("analysis.duration")}
          <input className={input} value={duration} onChange={(e) => setDuration(e.target.value)} inputMode="decimal" />
        </label>
        <button onClick={() => void compare()} className="inline-flex items-center gap-1 rounded bg-accent px-3 py-1.5 font-medium text-white">
          <GitCompare size={12} />
          {t("disc.compare")}
        </button>
        <div className="ml-auto flex items-end gap-1">
          <label className="flex w-48 flex-col gap-1">
            {t("disc.saveAs")}
            <input className={input} value={saveAs} onChange={(e) => setSaveAs(e.target.value)} />
          </label>
          <button onClick={() => void save()} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1.5">
            <Save size={12} />
            {t("disc.save")}
          </button>
        </div>
      </div>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-ok" : "text-danger"}>
          {message.text}
        </p>
      )}
      {cmp && (
        <>
          <p data-testid="disc-error">{t("disc.maxError", { value: cmp.maxAbsError.toPrecision(3) })}</p>
          <SeriesPlot
            x={cmp.times}
            testId="disc-plot"
            series={[
              { label: t("disc.continuous"), values: cmp.continuous, color: seriesColor(0) },
              { label: t("disc.discrete"), values: cmp.discrete, color: seriesColor(1), points: true },
            ]}
          />
        </>
      )}
    </section>
  );
}
