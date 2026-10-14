import type { SignalInfo } from "@modelviz/protocol";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { signalStore } from "../../state/session";
import { useRetained } from "../TimePlotPanel";
import { SignalPicker, useSignalsById } from "./SignalPicker";

/** Readable numbers, not the plot's refresh rate: ~10 updates per second. */
const REFRESH_MS = 100;

export function formatValue(v: number): string {
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  return a !== 0 && (a < 1e-3 || a >= 1e6) ? v.toExponential(4) : v.toFixed(4);
}

/** Latest value of each selected Signal. */
export function TablePanel({ n, selected, onChange }: { n: number; selected: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useTranslation();
  const signals = useSignalsById(selected);
  useRetained(signals);
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  const title = t("panels.tableTitle", { n });
  return (
    <section aria-label={title} data-testid={`table-panel-${n - 1}`} className="@container h-full min-h-0 bg-surface p-3">
      <div className="flex h-full min-h-0 flex-col gap-3 @[36rem]:flex-row">
        <div className="flex max-h-40 shrink-0 flex-col gap-2 overflow-auto @[36rem]:max-h-none @[36rem]:w-60">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
          <SignalPicker selected={selected} onToggle={toggle} />
        </div>
        <div className="min-w-0 flex-1 overflow-auto">
          {signals.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">{t("panels.pickTable")}</div>
          ) : (
            <LatestValues signals={signals} />
          )}
        </div>
      </div>
    </section>
  );
}

/** Values are written straight into the cells: high-rate data never goes through React state. */
function LatestValues({ signals }: { signals: SignalInfo[] }) {
  const { t } = useTranslation();
  const body = useRef<HTMLTableSectionElement>(null);

  useEffect(() => {
    const update = () => {
      const rows = body.current?.rows;
      if (!rows) return;
      signals.forEach((s, i) => {
        const b = signalStore.buffer(s.handle);
        const v = b.latestValue();
        const cells = rows[i]?.cells;
        if (!cells) return;
        const text = v === null ? "—" : formatValue(v);
        if (cells[1]!.textContent !== text) cells[1]!.textContent = text;
      });
    };
    update();
    const timer = setInterval(update, REFRESH_MS);
    return () => clearInterval(timer);
  }, [signals]);

  return (
    <table className="w-full text-sm" data-testid="value-table">
      <thead className="text-left text-xs text-muted">
        <tr>
          <th className="py-1 pr-3 font-normal">{t("panels.signal")}</th>
          <th className="py-1 pr-3 text-right font-normal">{t("panels.latest")}</th>
          <th className="py-1 font-normal">{t("panels.units")}</th>
        </tr>
      </thead>
      <tbody ref={body}>
        {signals.map((s) => (
          <tr key={s.id} className="border-t border-border" data-testid={`value-row-${s.id}`}>
            <td className="py-1 pr-3 font-mono">{s.id}</td>
            {/* filled by the interval above, never by React */}
            <td className="py-1 pr-3 text-right font-mono tabular-nums" data-testid="latest-value" />
            <td className="py-1 text-muted">{s.units ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
