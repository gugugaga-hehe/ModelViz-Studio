import { useTranslation } from "react-i18next";
import { ConnectionBadge } from "./components/ConnectionBadge";
import { LanguageSelect } from "./components/LanguageSelect";
import { ProjectPanel } from "./components/ProjectPanel";

export function App() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between gap-4 border-b border-border bg-surface px-4 py-2">
        <h1 className="font-semibold">{t("app.title")}</h1>
        <div className="flex items-center gap-4">
          <ConnectionBadge />
          <LanguageSelect />
        </div>
      </header>
      <main className="flex flex-1 items-start justify-center p-6">
        <ProjectPanel />
      </main>
    </div>
  );
}
