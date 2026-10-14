import type { RecordingInfo } from "@modelviz/protocol";
import { FileUp, Play } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { client, useSession } from "../state/session";
import { formatBytes, formatDuration } from "./format";
import { ReplayControls } from "./ReplayControls";
import { Button, Input, Select } from "./ui/controls";

export function RecordingsPanel() {
  const { t } = useTranslation();
  const recordings = useSession((s) => s.recordings);
  const sources = useSession((s) => s.sources);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  const busy = (device: string) => {
    const st = sources[device]?.state;
    return st !== undefined && st !== "stopped" && st !== "rejected";
  };
  /** The running Log Replay of this Recording, if any. */
  const replayOf = (r: RecordingInfo) => {
    const src = sources[r.device];
    return src?.kind === "replay" && src.replay?.recording === r.id && busy(r.device) ? src : null;
  };

  return (
    <section aria-labelledby="recordings-heading" className="mt-4 flex flex-col gap-2">
      <div className="flex items-center">
        <h2 id="recordings-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">
          {t("recordings.heading")}
        </h2>
        <Button
          onClick={() => setImporting((x) => !x)}
          variant="subtle"
          size="inline"
          className="ml-auto text-xs"
        >
          <FileUp size={12} />
          {t("csv.import")}
        </Button>
      </div>
      {importing && <CsvImportForm onDone={() => setImporting(false)} />}
      {recordings.length === 0 && <p className="text-sm text-muted">{t("recordings.none")}</p>}
      <ul className="flex flex-col gap-1">
        {recordings.map((r) => (
          <li key={r.id} className="rounded border border-border bg-bg px-2 py-1 text-xs" data-testid={`recording-${r.id}`}>
            <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium" title={r.id}>
                {r.active && <span className="mr-1 text-danger">●</span>}
                {r.id}
              </div>
              <div className="text-muted">
                {r.format === "csv" ? "CSV" : r.device} · {formatDuration(r.durationMs)} · {formatBytes(r.bytes)}
              </div>
            </div>
            {!r.active && (
              <Button
                disabled={busy(r.device)}
                onClick={() => {
                  setError(null);
                  client.request("source.startReplay", { device: r.device, recording: r.id }).catch((e: Error) => setError(e.message));
                }}
                aria-label={t("recordings.replay", { id: r.id })}
                size="icon"
              >
                <Play size={12} />
              </Button>
            )}
            </div>
            {replayOf(r) && <ReplayControls source={replayOf(r)!} />}
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

function CsvImportForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [timeColumn, setTimeColumn] = useState("");
  const [timeUnit, setTimeUnit] = useState<"s" | "ms" | "us">("s");
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      aria-label={t("csv.title")}
      className="flex flex-col gap-2 rounded border border-border p-2 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        client
          .request("csv.import", { path, name, timeUnit, ...(timeColumn ? { timeColumn } : {}) })
          .then(onDone, (err: Error) => setError(err.message));
      }}
    >
      <label className="flex flex-col gap-1">
        {t("csv.path")}
        <Input className="w-full" value={path} onChange={(e) => setPath(e.target.value)} required placeholder="/home/me/log.csv" />
      </label>
      <label className="flex flex-col gap-1">
        {t("csv.name")}
        <Input className="w-full" value={name} onChange={(e) => setName(e.target.value)} required pattern="[A-Za-z][A-Za-z0-9_-]*" />
      </label>
      <div className="flex gap-1">
        <label className="flex flex-[2] flex-col gap-1">
          {t("csv.timeColumn")}
          <Input className="w-full" value={timeColumn} onChange={(e) => setTimeColumn(e.target.value)} placeholder={t("csv.firstColumn")} />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          {t("csv.timeUnit")}
          <Select className="w-full" value={timeUnit} onChange={(e) => setTimeUnit(e.target.value as "s" | "ms" | "us")}>
            <option value="s">s</option>
            <option value="ms">ms</option>
            <option value="us">µs</option>
          </Select>
        </label>
      </div>
      <Button type="submit" variant="primary">
        {t("csv.submit")}
      </Button>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
