import type { ValidationIssue } from "@modelviz/protocol";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { client, refreshModels, useSession } from "../../state/session";

/** Text-first editor for a Project file (Block, System, Frame Format, dialect). */
export function FileEditor({ path }: { path: string }) {
  const { t } = useTranslation();
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState<string | null>(null);
  const block = useSession((s) => s.blocks.find((b) => b.path === path));
  const system = useSession((s) => s.systems.find((x) => x.path === path));
  const issues: ValidationIssue[] = system?.issues ?? (block?.error ? [{ code: "invalid_block", message: block.error }] : []);

  useEffect(() => {
    setContent(null);
    setError(null);
    client.request("files.read", { path }).then(
      (f) => {
        setContent(f.content);
        setSaved(f.content);
      },
      (e: Error) => setError(e.message),
    );
  }, [path]);

  async function save() {
    if (content === null) return;
    setError(null);
    try {
      await client.request("files.write", { path, content });
      setSaved(content);
      await refreshModels();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const dirty = content !== null && content !== saved;
  return (
    <section aria-label={t("model.editor", { path })} className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <code className="truncate text-sm">{path}</code>
        {dirty && <span className="text-xs text-warn">{t("model.unsaved")}</span>}
        <button
          onClick={() => void save()}
          disabled={!dirty}
          className="ml-auto inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-xs font-medium text-white disabled:opacity-40"
        >
          <Save size={12} />
          {t("model.save")}
        </button>
      </div>
      <textarea
        aria-label={t("model.content")}
        spellCheck={false}
        value={content ?? ""}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            void save();
          }
        }}
        className="min-h-48 flex-1 resize-none rounded border border-border bg-bg p-2 font-mono text-xs leading-5 outline-none focus:border-accent"
      />
      {(issues.length > 0 || error) && (
        <ul role="alert" aria-label={t("model.issues")} className="flex flex-col gap-1 text-xs text-danger">
          {error && <li>{error}</li>}
          {issues.map((i, n) => (
            <li key={n}>
              <span className="font-mono">{i.code}</span>: {i.message}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
