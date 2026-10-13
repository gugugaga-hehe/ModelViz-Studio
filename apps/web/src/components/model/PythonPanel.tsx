import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { client, useSession } from "../../state/session";

/** Status and declaration of the Project's Python environment (ADR-0005). */
export function PythonPanel() {
  const { t } = useTranslation();
  const status = useSession((s) => s.python);
  const [editing, setEditing] = useState(false);
  const [deps, setDeps] = useState("");
  const [version, setVersion] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) setDeps((status?.dependencies ?? []).join("\n"));
  }, [status, editing]);

  async function save() {
    setError(null);
    try {
      await client.request("python.configure", {
        dependencies: deps.split("\n").map((l) => l.trim()).filter(Boolean),
        ...(version ? { version } : {}),
      });
      setEditing(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const state = status?.state ?? "absent";
  const color = { absent: "text-muted", preparing: "text-warn", ready: "text-ok", failed: "text-danger" }[state];
  return (
    <section aria-labelledby="python-heading" className="flex flex-col gap-1 text-xs" data-testid="python-panel" data-state={state}>
      <div className="flex items-center gap-1">
        <h2 id="python-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">
          Python
        </h2>
        <span className={`ml-auto inline-flex items-center gap-1 ${color}`} data-testid="python-state">
          {state === "preparing" && <Loader2 size={12} className="animate-spin" />}
          {t(`python.state.${state}`)}
          {state === "ready" && status?.version ? ` · ${status.version}` : ""}
        </span>
      </div>
      {state === "preparing" && status?.log.length ? <p className="truncate text-muted" title={status.log.at(-1)}>{status.log.at(-1)}</p> : null}
      {state === "failed" && (
        <div className="flex items-start gap-1">
          <p role="alert" className="flex-1 text-danger">
            {status?.error}
          </p>
          <button onClick={() => void client.request("python.sync", {})} aria-label={t("python.retry")} className="rounded border border-border p-1">
            <RefreshCw size={12} />
          </button>
        </div>
      )}
      {state === "ready" && (
        <p className="text-muted" data-testid="python-locked">
          {t("python.packages", { count: status?.locked.length ?? 0 })}
        </p>
      )}
      {editing ? (
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            {t("python.dependencies")}
            <textarea
              aria-label={t("python.dependencies")}
              className="h-20 rounded border border-border bg-bg p-1 font-mono"
              value={deps}
              onChange={(e) => setDeps(e.target.value)}
              placeholder={"numpy\nscipy>=1.11"}
            />
          </label>
          <label className="flex flex-col gap-1">
            {t("python.version")}
            <input aria-label={t("python.version")} className="rounded border border-border bg-bg px-1 py-0.5" value={version} onChange={(e) => setVersion(e.target.value)} placeholder="3.12" />
          </label>
          <div className="flex gap-1">
            <button onClick={() => void save()} className="flex-1 rounded bg-accent px-2 py-1 font-medium text-white">
              {t("python.apply")}
            </button>
            <button onClick={() => setEditing(false)} className="rounded border border-border px-2 py-1">
              {t("connect.cancel")}
            </button>
          </div>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </div>
      ) : (
        <button onClick={() => setEditing(true)} className="self-start text-muted hover:text-fg">
          {t(state === "absent" ? "python.setUp" : "python.edit")}
        </button>
      )}
    </section>
  );
}
