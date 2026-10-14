import { ArrowLeftRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ConnectionBadge } from "./components/ConnectionBadge";
import { DevicesPanel } from "./components/DevicesPanel";
import { LanguageSelect } from "./components/LanguageSelect";
import { ModelLab } from "./components/model/ModelLab";
import { ParametersView } from "./components/ParametersView";
import { ProjectPanel } from "./components/ProjectPanel";
import { LiveSystemsPanel } from "./components/LiveSystemsPanel";
import { RecordingsPanel } from "./components/RecordingsPanel";
import { Workspace } from "./components/Workspace";
import { useSession } from "./state/session";
import { Button } from "./components/ui/controls";

export function App() {
  const { t } = useTranslation();
  const project = useSession((s) => s.project);
  const [choosing, setChoosing] = useState(false);
  const [view, setView] = useState<"telemetry" | "model" | "parameters">("telemetry");
  const showChooser = !project || choosing;

  return (
    <div className="flex h-screen flex-col">
      {/* one row at any width: labels never wrap, the view tabs scroll when space runs out */}
      <header className="flex items-center justify-between gap-4 border-b border-border bg-surface px-4 py-2" data-testid="app-header">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="shrink-0 whitespace-nowrap font-semibold">{t("app.title")}</h1>
          {project && !showChooser && (
            <nav className="ml-2 flex min-w-0 gap-1 overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label={t("app.views")}>
              {(["telemetry", "model", "parameters"] as const).map((v) => (
                <Button
                  key={v}
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  variant="toggle"
                  pressed={view === v}
                  className="shrink-0 whitespace-nowrap text-sm"
                >
                  {t(`app.view.${v}`)}
                </Button>
              ))}
            </nav>
          )}
          {project && (
            <Button
              onClick={() => setChoosing((c) => !c)}
              variant="subtle"
              className="min-w-0 text-sm"
              title={project.path}
            >
              <span data-testid="project-name" className="max-w-48 truncate">
                {project.name}
              </span>
              <ArrowLeftRight size={14} aria-label={t("project.switch")} className="shrink-0" />
            </Button>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-4">
          <ConnectionBadge />
          <LanguageSelect />
        </div>
      </header>
      {showChooser ? (
        <main className="flex flex-1 items-start justify-center overflow-auto p-6">
          <ProjectPanel onDone={() => setChoosing(false)} />
        </main>
      ) : view === "model" ? (
        <main className="flex min-h-0 flex-1 p-3">
          <ModelLab />
        </main>
      ) : view === "parameters" ? (
        <main className="flex min-h-0 flex-1 p-3">
          <ParametersView />
        </main>
      ) : (
        <main className="flex min-h-0 flex-1 gap-3 p-3">
          <aside className="w-64 shrink-0 overflow-auto rounded-lg border border-border bg-surface p-3">
            <DevicesPanel />
            <RecordingsPanel />
            <LiveSystemsPanel />
          </aside>
          <Workspace />
        </main>
      )}
    </div>
  );
}
