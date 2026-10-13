import type { LinkHealth } from "@modelviz/protocol";
import { useTranslation } from "react-i18next";

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className={value > 0 ? "font-medium text-danger" : ""}>{value}</span>
    </div>
  );
}

/** Link health of one Device: Framing-level errors plus per-Message rate checks. */
export function LinkHealthView({ health }: { health: LinkHealth }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2 text-xs" data-testid={`link-health-${health.device}`}>
      <div className="flex justify-between gap-2">
        <span className="text-muted">{t("health.frames")}</span>
        <span>{health.frames}</span>
      </div>
      <Count label={t("health.crcErrors")} value={health.crcErrors} />
      <Count label={t("health.sequenceGaps")} value={health.sequenceGaps} />
      <Count label={t("health.unknownMessages")} value={health.unknownMessages} />
      <table className="mt-1 w-full">
        <thead className="text-muted">
          <tr>
            <th className="text-left font-normal">{t("health.message")}</th>
            <th className="text-right font-normal">Hz</th>
            <th className="text-right font-normal" title={t("health.missedTitle")}>
              {t("health.missed")}
            </th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(health.messages).map(([name, m]) => {
            const bad = m.rateDeviation || m.timingJumps > 0;
            return (
              <tr key={name} data-testid={`message-health-${name}`} className={bad ? "text-warn" : ""}>
                <td className="max-w-24 truncate" title={name}>
                  {name}
                </td>
                <td className="text-right tabular-nums" title={m.nominalRateHz ? `${t("health.nominal")} ${m.nominalRateHz} Hz` : ""}>
                  {m.rateHz.toFixed(0)}
                  {m.nominalRateHz ? <span className="text-muted">/{m.nominalRateHz}</span> : null}
                </td>
                <td className={`text-right tabular-nums ${m.missedFrames ? "text-danger" : ""}`}>
                  {m.missedFrames}
                  {m.timingJumps > 0 && <span title={t("health.timingJumps")}> ⚠{m.timingJumps}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
