import type { SourceState } from "@modelviz/protocol";
import { Cable, Circle, Cpu, Play, Square } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { client, useSession } from "../state/session";
import { ConnectForm } from "./ConnectForm";
import { formatDuration } from "./format";
import { LinkHealthView } from "./LinkHealthView";

const STATE_COLOR: Record<SourceState["state"], string> = {
  connecting: "text-warn",
  verifying: "text-warn",
  running: "text-ok",
  lost: "text-danger",
  rejected: "text-danger",
  stopped: "text-muted",
};

export function DevicesPanel() {
  const { t } = useTranslation();
  const devices = useSession((s) => s.devices);
  const sources = useSession((s) => s.sources);
  const health = useSession((s) => s.health);
  const recordings = useSession((s) => s.recordings);
  const [connecting, setConnecting] = useState<string | null>(null);
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
          const source = sources[d.id];
          const active = source && source.state !== "stopped" && source.state !== "rejected";
          const btn = "inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:border-accent";
          const recording = recordings.find((r) => r.device === d.id && r.active);
          const canRecord = source?.state === "running" && source.kind !== "replay";
          return (
            <li key={d.id} className="rounded border border-border bg-bg p-2 text-sm" data-testid={`device-${d.id}`}>
              <div className="flex items-center gap-2">
                <Cpu size={14} className="text-muted" />
                <span className="font-medium">{d.id}</span>
                {source && source.state !== "stopped" && (
                  <span className={`ml-auto text-xs ${STATE_COLOR[source.state]}`} data-testid="source-state">
                    {t(`source.${source.state}`)}
                    {source.kind !== "virtual" && source.transport ? ` · ${source.kind.toUpperCase()}` : ""}
                  </span>
                )}
              </div>
              <div className="truncate text-xs text-muted" title={d.frameFormat}>
                {d.frameFormat}
              </div>
              {d.dialectHash && (
                <div className="text-xs text-muted">
                  {t("devices.dialectHash")}: <code className="select-all">{d.dialectHash}</code>
                </div>
              )}
              {d.error && <p className="mt-1 text-xs text-danger">{d.error}</p>}
              {source?.error && (
                <p role="alert" className="mt-1 text-xs text-danger">
                  {source.error}
                </p>
              )}
              {health[d.id] && active && <LinkHealthView health={health[d.id]!} />}
              {!d.error && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {active ? (
                    <>
                      <button className={btn} onClick={() => run(() => client.request("source.stop", { device: d.id }))}>
                        <Square size={12} />
                        {t("devices.stop")}
                      </button>
                      {recording ? (
                        <button className={`${btn} text-danger`} onClick={() => run(() => client.request("recording.stop", { device: d.id }))}>
                          <Square size={12} />
                          {t("recordings.stop")} {formatDuration(recording.durationMs)}
                        </button>
                      ) : (
                        canRecord && (
                          <button className={btn} onClick={() => run(() => client.request("recording.start", { device: d.id }))}>
                            <Circle size={12} className="fill-danger text-danger" />
                            {t("recordings.record")}
                          </button>
                        )
                      )}
                    </>
                  ) : (
                    <>
                      <button className={btn} onClick={() => setConnecting(connecting === d.id ? null : d.id)}>
                        <Cable size={12} />
                        {t("devices.connect")}
                      </button>
                      {d.virtual && (
                        <button className={btn} onClick={() => run(() => client.request("source.startVirtual", { device: d.id }))}>
                          <Play size={12} />
                          {t("devices.startVirtual")}
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
              {connecting === d.id && !active && <ConnectForm device={d} onDone={() => setConnecting(null)} />}
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
