import type { SourceState } from "@modelviz/protocol";
import { Pause, Play } from "lucide-react";
import { useTranslation } from "react-i18next";
import { client } from "../state/session";
import { formatDuration } from "./format";

const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];

export function ReplayControls({ source }: { source: SourceState }) {
  const { t } = useTranslation();
  const r = source.replay;
  if (!r) return null;
  const control = (action: "play" | "pause" | "seek" | "speed", extra: { positionMs?: number; speed?: number } = {}) =>
    void client.request("replay.control", { device: source.device, action, ...extra }).catch(() => {});
  return (
    <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2 text-xs" data-testid="replay-controls">
      <div className="truncate text-muted" title={r.recording}>
        {t("replay.of", { recording: r.recording })}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => control(r.playing ? "pause" : "play")}
          aria-label={t(r.playing ? "replay.pause" : "replay.play")}
          className="rounded border border-border p-1"
        >
          {r.playing ? <Pause size={12} /> : <Play size={12} />}
        </button>
        <input
          type="range"
          min={0}
          max={Math.max(1, r.durationMs)}
          step={10}
          value={r.positionMs}
          onChange={(e) => control("seek", { positionMs: Number(e.target.value) })}
          aria-label={t("replay.position")}
          className="flex-1"
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="tabular-nums" data-testid="replay-position">
          {formatDuration(r.positionMs)} / {formatDuration(r.durationMs)}
        </span>
        <select
          aria-label={t("replay.speed")}
          value={r.speed}
          onChange={(e) => control("speed", { speed: Number(e.target.value) })}
          className="rounded border border-border bg-surface px-1"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
