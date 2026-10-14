import { Play } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { client, useSession } from "../state/session";
import { formatBytes, formatDuration } from "./format";

export function RecordingsPanel() {
  const { t } = useTranslation();
  const recordings = useSession((s) => s.recordings);
  const sources = useSession((s) => s.sources);
  const [error, setError] = useState<string | null>(null);

  const busy = (device: string) => {
    const st = sources[device]?.state;
    return st !== undefined && st !== "stopped" && st !== "rejected";
  };

  return (
    <section aria-labelledby="recordings-heading" className="mt-4 flex flex-col gap-2">
      <h2 id="recordings-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">
        {t("recordings.heading")}
      </h2>
      {recordings.length === 0 && <p className="text-sm text-muted">{t("recordings.none")}</p>}
      <ul className="flex flex-col gap-1">
        {recordings.map((r) => (
          <li key={r.id} className="flex items-center gap-2 rounded border border-border bg-bg px-2 py-1 text-xs" data-testid={`recording-${r.id}`}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium" title={r.id}>
                {r.active && <span className="mr-1 text-danger">●</span>}
                {r.id}
              </div>
              <div className="text-muted">
                {r.device} · {formatDuration(r.durationMs)} · {formatBytes(r.bytes)}
              </div>
            </div>
            {!r.active && (
              <button
                disabled={busy(r.device)}
                onClick={() => {
                  setError(null);
                  client.request("source.startReplay", { device: r.device, recording: r.id }).catch((e: Error) => setError(e.message));
                }}
                aria-label={t("recordings.replay", { id: r.id })}
                className="rounded border border-border p-1 disabled:opacity-40"
              >
                <Play size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
