import { RequestError } from "@modelviz/client";
import type { ProjectTemplate } from "@modelviz/protocol";
import { FolderOpen, FolderPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";
import { client, useSession } from "../state/session";

type Mode = "create" | "open";

export function ProjectPanel({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation();
  const project = useSession((s) => s.project);
  const connected = useSession((s) => s.connection === "connected");
  const [mode, setMode] = useState<Mode>("open");
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<ProjectTemplate>("virtual-bench");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") await client.request("project.create", { path, name, template });
      else await client.request("project.open", { path });
      onDone?.();
    } catch (err) {
      setError(err instanceof RequestError || err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-accent";

  return (
    <section className="w-full max-w-xl rounded-lg border border-border bg-surface p-5" aria-labelledby="project-heading">
      <h2 id="project-heading" className="mb-3 text-lg font-semibold">
        {t("project.heading")}
      </h2>
      <p className="mb-4 text-sm" data-testid="current-project">
        {project ? (
          <>
            <span className="text-muted">{t("project.current")}: </span>
            <strong>{project.name}</strong> <span className="text-muted">— {project.path}</span>
          </>
        ) : (
          <span className="text-muted">{t("project.none")}</span>
        )}
      </p>

      <div className="mb-3 flex gap-1" role="tablist">
        {(["open", "create"] as const).map((m) => (
          <button
            key={m}
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`rounded px-3 py-1 text-sm ${mode === m ? "bg-accent text-white" : "text-muted hover:text-fg"}`}
          >
            {t(`project.mode.${m}`)}
          </button>
        ))}
      </div>

      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {t("project.path")}
          <input className={input} value={path} onChange={(e) => setPath(e.target.value)} required placeholder="/home/me/projects/bench" />
        </label>
        {mode === "create" && (
          <label className="flex flex-col gap-1 text-sm">
            {t("project.name")}
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
        )}
        {mode === "create" && (
          <label className="flex flex-col gap-1 text-sm">
            {t("project.template")}
            <select className={input} value={template} onChange={(e) => setTemplate(e.target.value as ProjectTemplate)}>
              <option value="virtual-bench">{t("project.templates.virtual-bench")}</option>
              <option value="empty">{t("project.templates.empty")}</option>
            </select>
          </label>
        )}
        <button
          type="submit"
          disabled={!connected || busy}
          className="inline-flex items-center justify-center gap-2 rounded bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {mode === "create" ? <FolderPlus size={16} /> : <FolderOpen size={16} />}
          {t(mode === "create" ? "project.create" : "project.open")}
        </button>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {t("project.error", { message: error })}
          </p>
        )}
      </form>
    </section>
  );
}
