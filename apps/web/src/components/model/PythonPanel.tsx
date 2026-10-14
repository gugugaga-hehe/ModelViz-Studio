import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { client, usePythonOutput, useSession } from "../../state/session";
import { Button, Input, Textarea } from "../ui/controls";

/** Status and declaration of the Project's Python environment (ADR-0005). */
export function PythonPanel() {
  const { t } = useTranslation();
  const status = useSession((s) => s.python);
  const output = usePythonOutput();
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
          <Button onClick={() => void client.request("python.sync", {})} aria-label={t("python.retry")} size="icon">
            <RefreshCw size={12} />
          </Button>
        </div>
      )}
      {state === "ready" && (
        <p className="text-muted" data-testid="python-locked">
          {t("python.packages", { count: status?.locked.length ?? 0 })}
        </p>
      )}
      {output.text && (
        <details className="flex flex-col gap-1" data-testid="python-output">
          <summary className="cursor-pointer text-muted hover:text-fg">{t("python.output")}</summary>
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded border border-border bg-bg p-1 font-mono">{output.text}</pre>
          <Button onClick={output.clear} variant="subtle" size="inline" className="self-start">
            {t("python.clearOutput")}
          </Button>
        </details>
      )}
      {editing ? (
        <div className="flex flex-col gap-1">
          <label className="flex flex-col gap-1">
            {t("python.dependencies")}
            <Textarea
              aria-label={t("python.dependencies")}
              className="h-20 font-mono"
              value={deps}
              onChange={(e) => setDeps(e.target.value)}
              placeholder={"numpy\nscipy>=1.11"}
            />
          </label>
          <label className="flex flex-col gap-1">
            {t("python.version")}
            <Input aria-label={t("python.version")} value={version} onChange={(e) => setVersion(e.target.value)} placeholder="3.12" />
          </label>
          <div className="flex gap-1">
            <Button onClick={() => void save()} variant="primary" className="flex-1">
              {t("python.apply")}
            </Button>
            <Button onClick={() => setEditing(false)} >
              {t("connect.cancel")}
            </Button>
          </div>
          {error && (
            <p role="alert" className="text-danger">
              {error}
            </p>
          )}
        </div>
      ) : (
        <Button onClick={() => setEditing(true)} variant="subtle" size="inline" className="self-start">
          {t(state === "absent" ? "python.setUp" : "python.edit")}
        </Button>
      )}
    </section>
  );
}
