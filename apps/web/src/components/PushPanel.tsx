import type { MappingInfo, ParameterMapping, PushPreview, PushResult } from "@modelviz/protocol";
import { Plus, Save, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { client, useSession } from "../state/session";
import { Button, Input, Select } from "./ui/controls";


const blockLabel = (m: ParameterMapping) => `${m.system.replace(/^systems\//, "").replace(/\.ya?ml$/, "")} › ${m.block}.${m.parameter}`;

/** Parameter Mappings of the Project and the Push of their Block Parameter values to one Device. */
export function PushPanel({ device, reachable, deviceParameters }: { device: string; reachable: boolean; deviceParameters: string[] }) {
  const { t } = useTranslation();
  const project = useSession((s) => s.project);
  const systems = useSession((s) => s.systems);
  const devices = useSession((s) => s.devices);
  const [rows, setRows] = useState<MappingInfo[]>([]);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PushPreview | null>(null);
  const [result, setResult] = useState<PushResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!project) return;
    client.request("mappings.list", {}).then((m) => {
      setRows(m);
      setDirty(false);
    }, () => {});
  }, [project, systems]);

  function edit(i: number, patch: Partial<ParameterMapping>) {
    setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch, blockValue: undefined, issue: undefined } : r)));
    setDirty(true);
  }

  async function save() {
    setError(null);
    try {
      const mappings = rows.map(({ system, block, parameter, device, deviceParameter }) => ({ system, block, parameter, device, deviceParameter }));
      setRows(await client.request("mappings.set", { mappings }));
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function startPush() {
    setError(null);
    setResult(null);
    setBusy(true);
    try {
      setPreview(await client.request("push.preview", { device }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    try {
      setResult(await client.request("push.apply", { id: preview.id }));
    } catch (e) {
      setError((e as Error).message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  const close = () => {
    setPreview(null);
    setResult(null);
  };
  const changes = preview?.entries.filter((e) => e.status === "changed").length ?? 0;
  const firstSystem = systems[0];

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-3" data-testid="push-panel">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-semibold">{t("push.mappings")}</h3>
        <Button onClick={() => void startPush()} disabled={!reachable || busy || dirty || !rows.some((r) => r.device === device)}>
          <Upload size={12} />
          {t("push.push")}
        </Button>
      </div>
      <p className="text-xs text-muted">{t("push.explain")}</p>
      {rows.length > 0 && (
        <table className="w-full text-sm" data-testid="mappings-table">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1 pr-2 font-normal">{t("push.system")}</th>
              <th className="py-1 pr-2 font-normal">{t("push.block")}</th>
              <th className="py-1 pr-2 font-normal">{t("push.blockParameter")}</th>
              <th className="py-1 pr-2 font-normal">{t("push.value")}</th>
              <th className="py-1 pr-2 font-normal">{t("params.device")}</th>
              <th className="py-1 pr-2 font-normal">{t("push.deviceParameter")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const sys = systems.find((s) => s.path === r.system);
              const blocks = Object.keys(sys?.parameters ?? {}).filter((b) => Object.keys(sys!.parameters[b]!).length);
              const params = Object.keys(sys?.parameters[r.block] ?? {});
              return (
                <tr key={i} className="border-t border-border" data-testid={`mapping-${i}`}>
                  <td className="py-1 pr-2">
                    <Select aria-label={t("push.system")} size="md" value={r.system} onChange={(e) => edit(i, { system: e.target.value })}>
                      {!sys && <option value={r.system}>{r.system}</option>}
                      {systems.map((s) => (
                        <option key={s.path} value={s.path}>
                          {s.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="py-1 pr-2">
                    <Select aria-label={t("push.block")} size="md" value={r.block} onChange={(e) => edit(i, { block: e.target.value })}>
                      {!blocks.includes(r.block) && <option value={r.block}>{r.block}</option>}
                      {blocks.map((b) => (
                        <option key={b}>{b}</option>
                      ))}
                    </Select>
                  </td>
                  <td className="py-1 pr-2">
                    <Select aria-label={t("push.blockParameter")} size="md" value={r.parameter} onChange={(e) => edit(i, { parameter: e.target.value })}>
                      {!params.includes(r.parameter) && <option value={r.parameter}>{r.parameter}</option>}
                      {params.map((p) => (
                        <option key={p}>{p}</option>
                      ))}
                    </Select>
                  </td>
                  <td className="py-1 pr-2 font-mono" data-testid="mapping-value">
                    {r.blockValue ?? ""}
                    {r.issue && <span className="block text-xs text-danger">{r.issue}</span>}
                  </td>
                  <td className="py-1 pr-2">
                    <Select aria-label={t("params.device")} size="md" value={r.device} onChange={(e) => edit(i, { device: e.target.value })}>
                      {!devices.some((d) => d.id === r.device) && <option value={r.device}>{r.device}</option>}
                      {devices.map((d) => (
                        <option key={d.id}>{d.id}</option>
                      ))}
                    </Select>
                  </td>
                  <td className="py-1 pr-2">
                    <Input
                      aria-label={t("push.deviceParameter")}
                      size="md"
                      className="w-36 font-mono"
                      list="device-parameter-names"
                      value={r.deviceParameter}
                      onChange={(e) => edit(i, { deviceParameter: e.target.value })}
                    />
                  </td>
                  <td className="py-1">
                    <Button
                      aria-label={t("push.remove")}
                      onClick={() => {
                        setRows((rs) => rs.filter((_, k) => k !== i));
                        setDirty(true);
                      }}
                    >
                      <Trash2 size={12} />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <datalist id="device-parameter-names">
        {deviceParameters.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <div className="flex gap-2">
        {firstSystem && (
          <Button
            onClick={() => {
              const block = Object.keys(firstSystem.parameters).find((b) => Object.keys(firstSystem.parameters[b]!).length) ?? "";
              const parameter = Object.keys(firstSystem.parameters[block] ?? {})[0] ?? "";
              setRows((rs) => [...rs, { system: firstSystem.path, block, parameter, device, deviceParameter: "" }]);
              setDirty(true);
            }}
          >
            <Plus size={12} />
            {t("push.add")}
          </Button>
        )}
        <Button onClick={() => void save()} disabled={!dirty}>
          <Save size={12} />
          {t("push.save")}
        </Button>
        {dirty && <span className="text-xs text-warn">{t("push.unsaved")}</span>}
      </div>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      {preview && (
        <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/50 p-4">
          <div role="dialog" aria-modal="true" aria-labelledby="push-title" className="flex max-h-full w-full max-w-3xl flex-col gap-3 overflow-auto rounded-lg border border-border bg-surface p-4">
            <h3 id="push-title" className="font-semibold">
              {t(result ? "push.resultTitle" : "push.reviewTitle", { device: preview.device })}
            </h3>
            {!result && <p className="text-sm text-muted">{t("push.reviewExplain")}</p>}
            <table className="w-full text-sm" data-testid={result ? "push-results" : "push-diff"}>
              <thead className="text-left text-xs text-muted">
                <tr>
                  <th className="py-1 pr-2 font-normal">{t("push.deviceParameter")}</th>
                  <th className="py-1 pr-2 font-normal">{t("push.blockParameter")}</th>
                  <th className="py-1 pr-2 font-normal">{t(result ? "push.before" : "push.onDevice")}</th>
                  <th className="py-1 pr-2 font-normal">{t("push.proposed")}</th>
                  <th className="py-1 font-normal">{t(result ? "push.outcome" : "push.status")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.entries.map((e, i) => {
                  const r = result?.results[i];
                  return (
                    <tr key={i} className="border-t border-border" data-testid={`push-row-${e.mapping.deviceParameter}`}>
                      <td className="py-1 pr-2 font-mono">{e.mapping.deviceParameter}</td>
                      <td className="py-1 pr-2">{blockLabel(e.mapping)}</td>
                      <td className="py-1 pr-2 font-mono">{e.current ? String(Number(e.current.value.toPrecision(7))) : "—"}</td>
                      <td className={`py-1 pr-2 font-mono ${e.status === "changed" ? "font-semibold text-accent" : ""}`}>{e.proposed ?? "—"}</td>
                      {r ? (
                        <td className={`py-1 text-xs ${r.outcome === "acknowledged" ? "text-ok" : r.outcome === "not_written" ? "text-muted" : "text-danger"}`} data-testid="push-outcome" data-outcome={r.outcome}>
                          {t(`push.outcomes.${r.outcome}`, { value: r.parameter ? String(Number(r.parameter.value.toPrecision(7))) : "" })}
                          {r.outcome === "failed" && r.message ? `: ${r.message}` : ""}
                        </td>
                      ) : (
                        <td className={`py-1 text-xs ${e.status === "changed" ? "text-accent" : e.status === "unchanged" ? "text-muted" : "text-danger"}`} data-testid="push-status" data-status={e.status}>
                          {t(`push.statuses.${e.status}`)}
                          {e.message ? `: ${e.message}` : ""}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex justify-end gap-2">
              {result ? (
                <Button onClick={close}>
                  {t("push.close")}
                </Button>
              ) : (
                <>
                  <Button onClick={close} disabled={busy}>
                    {t("push.cancel")}
                  </Button>
                  <Button variant="primary" onClick={() => void confirm()} disabled={busy || changes === 0}>
                    <Upload size={12} />
                    {t("push.confirm", { count: changes })}
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
