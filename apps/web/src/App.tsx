import { ArrowLeftRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectionBadge } from "./components/ConnectionBadge";
import { DevicesPanel } from "./components/DevicesPanel";
import { LanguageSelect } from "./components/LanguageSelect";
import { ProjectPanel } from "./components/ProjectPanel";
import { RecordingsPanel } from "./components/RecordingsPanel";
import { PlotStack } from "./components/PlotStack";
import { useSession } from "./state/session";

export function App() {
  const { t } = useTranslation();
  const project = useSession((s) => s.project);
  const [choosing, setChoosing] = useState(false);
  const showChooser = !project || choosing;

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-surface px-4 py-2">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold">{t("app.title")}</h1>
          {project && (
            <button
              onClick={() => setChoosing((c) => !c)}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-sm text-muted hover:text-fg"
              title={project.path}
            >
              <span data-testid="project-name">{project.name}</span>
              <ArrowLeftRight size={14} aria-label={t("project.switch")} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-4">
          <ConnectionBadge />
          <LanguageSelect />
        </div>
      </header>
      {showChooser ? (
        <main className="flex flex-1 items-start justify-center overflow-auto p-6">
          <ProjectPanel onDone={() => setChoosing(false)} />
        </main>
      ) : (
        <main className="flex min-h-0 flex-1 gap-3 p-3">
          <aside className="w-64 shrink-0 overflow-auto rounded-lg border border-border bg-surface p-3">
            <DevicesPanel />
            <RecordingsPanel />
          </aside>
          <PlotStack />
        </main>
      )}
    </div>
  );
}
