import type { SignalInfo } from "@modelviz/protocol";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useSession } from "../../state/session";
import { Input, Select } from "../ui/controls";

function groupByMessage(signals: SignalInfo[]): [string, SignalInfo[]][] {
  const groups = new Map<string, SignalInfo[]>();
  for (const s of signals) {
    const key = `${s.device}/${s.message}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups];
}

/** Signals grouped by Device and Message, as checkboxes. */
export function SignalPicker({ selected, onToggle }: { selected: string[]; onToggle: (id: string) => void }) {
  const { t } = useTranslation();
  const signals = useSession((s) => s.signals);
  if (signals.length === 0) return <p className="text-sm text-muted">{t("plot.noSignals")}</p>;
  return (
    <>
      {groupByMessage(signals).map(([group, list]) => (
        <fieldset key={group} className="text-sm">
          <legend className="mb-1 text-xs text-muted">{group}</legend>
          {list.map((s) => (
            <label key={s.id} className="flex items-center gap-2 py-0.5">
              <input type="checkbox" checked={selected.includes(s.id)} onChange={() => onToggle(s.id)} aria-label={s.id} />
              <span>{s.field}</span>
              {s.units && <span className="text-xs text-muted">[{s.units}]</span>}
            </label>
          ))}
        </fieldset>
      ))}
    </>
  );
}

/** One Signal from a drop-down. */
export function SignalSelect({ label, value, onChange }: { label: string; value: string; onChange: (id: string) => void }) {
  const { t } = useTranslation();
  const signals = useSession((s) => s.signals);
  return (
    <label className="flex flex-col gap-1 text-xs text-muted">
      {label}
      <Select aria-label={label} size="md" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t("panels.noSignal")}</option>
        {signals.map((s) => (
          <option key={s.id} value={s.id}>
            {s.id}
          </option>
        ))}
      </Select>
    </label>
  );
}

/** The SignalInfo for each id that still exists (ids can outlive a Project change or edit). */
export function useSignalsById(ids: string[]): SignalInfo[] {
  const signals = useSession((s) => s.signals);
  const key = ids.join("\n");
  // stable identity while the ids and the Signal list are unchanged, so effects do not re-run
  return useMemo(() => (key ? key.split("\n") : []).map((id) => signals.find((s) => s.id === id)).filter((s): s is SignalInfo => !!s), [key, signals]);
}
