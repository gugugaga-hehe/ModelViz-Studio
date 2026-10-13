import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TimePlotPanel } from "./TimePlotPanel";

/** Vertically stacked time plots with synchronised cursors. */
export function PlotStack() {
  const { t } = useTranslation();
  const [ids, setIds] = useState([0]);
  const [next, setNext] = useState(1);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-auto">
      {ids.map((id, i) => (
        <TimePlotPanel key={id} index={i} onRemove={ids.length > 1 ? () => setIds(ids.filter((x) => x !== id)) : undefined} />
      ))}
      <button
        onClick={() => {
          setIds([...ids, next]);
          setNext(next + 1);
        }}
        className="inline-flex items-center justify-center gap-1 self-start rounded border border-dashed border-border px-3 py-1 text-sm text-muted hover:text-fg"
      >
        <Plus size={14} />
        {t("plot.add")}
      </button>
    </div>
  );
}
