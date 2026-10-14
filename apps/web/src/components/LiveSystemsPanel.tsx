import { Play, Square } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { client, useSession } from "../state/session";

/** Runs a System from a live Signal so its outputs can be plotted against the measurement. */
export function LiveSystemsPanel() {
  const { t } = useTranslation();
  const systems = useSession((s) => s.systems);
  const signals = useSession((s) => s.signals);
  const live = useSession((s) => s.live);
  const [system, setSystem] = useState("");
  const [signal, setSignal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputs = signals.filter((s) => !s.device.startsWith("system:"));
  const sys = system || systems[0]?.path || "";
  const sig = signal || inputs[0]?.id || "";
  const running = Object.values(live).filter((l) => l.running);
  const input = "w-full rounded border border-border bg-surface px-2 py-1 text-xs";

  async function start() {
    setError(null);
    try {
      await client.request("system.live.start", { system: sys, signal: sig });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section aria-labelledby="live-heading" className="mt-4 flex flex-col gap-2 text-xs" data-testid="live-systems">
      <h2 id="live-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">
        {t("live.heading")}
      </h2>
      {running.map((l) => (
        <div key={l.system} className="flex items-center gap-2 rounded border border-border bg-bg px-2 py-1" data-testid={`live-${l.system}`}>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium">{l.system.replace(/^systems\//, "").replace(/\.ya?ml$/, "")}</div>
            <div className="truncate text-muted" title={l.signal}>
              {l.input} ← {l.signal}
            </div>
          </div>
          <button onClick={() => void client.request("system.live.stop", { system: l.system })} aria-label={t("live.stop")} className="rounded border border-border p-1">
            <Square size={12} />
          </button>
        </div>
      ))}
      {Object.values(live)
        .filter((l) => l.error)
        .map((l) => (
          <p key={l.system} role="alert" className="text-danger">
            {l.error}
          </p>
        ))}
      {systems.length > 0 && inputs.length > 0 ? (
        <div className="flex flex-col gap-1">
          <select aria-label={t("live.system")} className={input} value={sys} onChange={(e) => setSystem(e.target.value)}>
            {systems.map((s) => (
              <option key={s.path} value={s.path}>
                {s.name}
              </option>
            ))}
          </select>
          <select aria-label={t("live.signal")} className={input} value={sig} onChange={(e) => setSignal(e.target.value)}>
            {inputs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
          <button onClick={() => void start()} className="inline-flex items-center justify-center gap-1 rounded border border-border px-2 py-1 hover:border-accent">
            <Play size={12} />
            {t("live.start")}
          </button>
        </div>
      ) : (
        <p className="text-muted">{t("live.none")}</p>
      )}
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
