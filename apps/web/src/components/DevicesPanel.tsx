import { Cpu, Play, Square } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { client, useSession } from "../state/session";
import { LinkHealthView } from "./LinkHealthView";

export function DevicesPanel() {
  const { t } = useTranslation();
  const devices = useSession((s) => s.devices);
  const sources = useSession((s) => s.sources);
  const health = useSession((s) => s.health);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section aria-labelledby="devices-heading" className="flex flex-col gap-2">
      <h2 id="devices-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">
        {t("devices.heading")}
      </h2>
      {devices.length === 0 && <p className="text-sm text-muted">{t("devices.none")}</p>}
      <ul className="flex flex-col gap-2">
        {devices.map((d) => {
          const running = sources[d.id]?.state === "running";
          return (
            <li key={d.id} className="rounded border border-border bg-bg p-2 text-sm" data-testid={`device-${d.id}`}>
              <div className="flex items-center gap-2">
                <Cpu size={14} className="text-muted" />
                <span className="font-medium">{d.id}</span>
                {running && <span className="ml-auto text-xs text-ok">{t("devices.running")}</span>}
              </div>
              <div className="truncate text-xs text-muted" title={d.frameFormat}>
                {d.frameFormat}
              </div>
              {d.error && <p className="mt-1 text-xs text-danger">{d.error}</p>}
              {health[d.id] && <LinkHealthView health={health[d.id]!} />}
              {d.virtual && !d.error && (
                <button
                  className="mt-2 inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:border-accent"
                  onClick={() =>
                    run(() =>
                      running
                        ? client.request("source.stop", { device: d.id })
                        : client.request("source.startVirtual", { device: d.id }),
                    )
                  }
                >
                  {running ? <Square size={12} /> : <Play size={12} />}
                  {t(running ? "devices.stop" : "devices.startVirtual")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
