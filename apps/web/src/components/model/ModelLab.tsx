import { Boxes, Network, Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useSession } from "../../state/session";
import { AnalysisPanel } from "./AnalysisPanel";
import { FileEditor } from "./FileEditor";
import { LoopTemplateForm } from "./LoopTemplateForm";

export function ModelLab() {
  const { t } = useTranslation();
  const blocks = useSession((s) => s.blocks);
  const systems = useSession((s) => s.systems);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const item = (path: string, label: string, bad: boolean, extra?: string) => (
    <li key={path}>
      <button
        onClick={() => setOpen(path)}
        aria-current={open === path}
        className={`flex w-full items-center gap-1 rounded px-2 py-1 text-left text-xs ${open === path ? "bg-accent/15" : "hover:bg-bg"}`}
      >
        <span className="truncate">{label}</span>
        {extra && <span className="text-muted">{extra}</span>}
        {bad && <span className="ml-auto text-danger">⚠</span>}
      </button>
    </li>
  );
  const openSystem = systems.some((s) => s.path === open) ? open : null;
  return (
    <div className="flex min-h-0 flex-1 gap-3">
      <aside className="flex w-56 shrink-0 flex-col gap-3 overflow-auto rounded-lg border border-border bg-surface p-3">
        <section aria-labelledby="blocks-heading">
          <h2 id="blocks-heading" className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted">
            <Boxes size={12} /> {t("model.blocks")}
          </h2>
          {blocks.length === 0 && <p className="text-xs text-muted">{t("model.noBlocks")}</p>}
          <ul>{blocks.map((b) => item(b.path, b.path.replace(/^blocks\//, ""), !!b.error, b.kind ? ` · ${b.kind}` : ""))}</ul>
        </section>
        <section aria-labelledby="systems-heading">
          <div className="mb-1 flex items-center">
            <h2 id="systems-heading" className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted">
              <Network size={12} /> {t("model.systems")}
            </h2>
            <button onClick={() => setCreating((c) => !c)} className="ml-auto inline-flex items-center gap-0.5 text-xs text-muted hover:text-fg">
              <Plus size={12} />
              {t("loop.new")}
            </button>
          </div>
          {creating && (
            <LoopTemplateForm
              onCreated={(p) => {
                setCreating(false);
                setOpen(p);
              }}
            />
          )}
          {systems.length === 0 && <p className="text-xs text-muted">{t("model.noSystems")}</p>}
          <ul>{systems.map((s) => item(s.path, s.name, s.issues.length > 0))}</ul>
        </section>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
        <div className="flex min-h-0 flex-1 rounded-lg border border-border bg-surface p-3">
          {open ? <FileEditor path={open} /> : <p className="m-auto text-sm text-muted">{t("model.pick")}</p>}
        </div>
        <div className="flex min-h-0 flex-1 rounded-lg border border-border bg-surface p-3">
          <AnalysisPanel system={openSystem} />
        </div>
      </div>
    </div>
  );
}
