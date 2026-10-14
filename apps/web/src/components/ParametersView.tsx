import type { DeviceParameter } from "@modelviz/protocol";
import { Download, RefreshCw, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { client, useSession } from "../state/session";
import { PushPanel } from "./PushPanel";
import { Button, Input, Select } from "./ui/controls";

/** Outcome of the last read or write of one Device Parameter. */
type RowStatus = { kind: "busy" } | { kind: "ack"; action: "read" | "write" } | { kind: "refused"; requested: number } | { kind: "error"; message: string };

/** Shows a value the way the Device stores it: single-precision floats without float noise. */
function show(p: DeviceParameter): string {
  return p.type === "float" ? String(Number(p.value.toPrecision(7))) : String(p.value);
}

/** Enumerates a Device's Device Parameters and reads or writes them one at a time. */
export function ParametersView() {
  const { t } = useTranslation();
  const devices = useSession((s) => s.devices);
  const sources = useSession((s) => s.sources);
  const [picked, setPicked] = useState("");
  const device = picked || devices[0]?.id || "";
  const source = sources[device];
  const reachable = source?.state === "running" && source.kind !== "replay";
  const [params, setParams] = useState<DeviceParameter[]>([]);
  const [missing, setMissing] = useState<number[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [listing, setListing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setParams([]);
    setMissing([]);
    setStatus({});
    setDrafts({});
  }, [device]);

  // values the Device reports (answers and unsolicited changes) keep the table current
  useEffect(
    () =>
      client.on("parameters.changed", (e) => {
        if (e.device !== device) return;
        setParams((ps) => (ps.some((p) => p.name === e.parameter.name) ? ps.map((p) => (p.name === e.parameter.name ? { ...e.parameter, index: p.index } : p)) : ps));
      }),
    [device],
  );

  async function enumerate() {
    setError(null);
    setListing(true);
    try {
      const list = await client.request("parameters.list", { device });
      setParams(list.parameters);
      setMissing(list.missing);
      setStatus({});
      setDrafts({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setListing(false);
    }
  }

  async function read(name: string) {
    setStatus((s) => ({ ...s, [name]: { kind: "busy" } }));
    try {
      await client.request("parameters.read", { device, name });
      setStatus((s) => ({ ...s, [name]: { kind: "ack", action: "read" } }));
    } catch (e) {
      setStatus((s) => ({ ...s, [name]: { kind: "error", message: (e as Error).message } }));
    }
  }

  async function write(name: string) {
    const value = Number(drafts[name]);
    if (drafts[name]?.trim() === "" || !Number.isFinite(value)) {
      setStatus((s) => ({ ...s, [name]: { kind: "error", message: t("params.notANumber") } }));
      return;
    }
    setStatus((s) => ({ ...s, [name]: { kind: "busy" } }));
    try {
      const r = await client.request("parameters.write", { device, name, value });
      setStatus((s) => ({ ...s, [name]: r.accepted ? { kind: "ack", action: "write" } : { kind: "refused", requested: r.requested } }));
      if (r.accepted) setDrafts((d) => ({ ...d, [name]: "" }));
    } catch (e) {
      setStatus((s) => ({ ...s, [name]: { kind: "error", message: (e as Error).message } }));
    }
  }


  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto rounded-lg border border-border bg-surface p-4" data-testid="parameters-view">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">{t("params.heading")}</h2>
        {devices.length > 1 && (
          <Select aria-label={t("params.device")} size="md" value={device} onChange={(e) => setPicked(e.target.value)}>
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.id}
              </option>
            ))}
          </Select>
        )}
        {device && (
          <Button onClick={() => void enumerate()} disabled={!reachable || listing}>
            <RefreshCw size={12} className={listing ? "animate-spin" : ""} />
            {t("params.enumerate")}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted">{t("params.explainPush")}</p>
      {!device ? (
        <p className="text-sm text-muted">{t("devices.none")}</p>
      ) : (
        !reachable && <p className="text-sm text-muted">{t(source?.kind === "replay" && source.state !== "stopped" ? "params.notFromReplay" : "params.notRunning", { device })}</p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {missing.length > 0 && (
        <p role="alert" className="text-sm text-warn">
          {t("params.missing", { indices: missing.join(", ") })}
        </p>
      )}
      {params.length > 0 && (
        <table className="w-full text-sm" data-testid="parameters-table">
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="py-1 pr-3 font-normal">#</th>
              <th className="py-1 pr-3 font-normal">{t("params.name")}</th>
              <th className="py-1 pr-3 font-normal">{t("params.type")}</th>
              <th className="py-1 pr-3 font-normal">{t("params.deviceValue")}</th>
              <th className="py-1 pr-3 font-normal">{t("params.newValue")}</th>
              <th className="py-1 font-normal">{t("params.status")}</th>
            </tr>
          </thead>
          <tbody>
            {params.map((p) => {
              const st = status[p.name];
              return (
                <tr key={p.name} className="border-t border-border" data-testid={`param-${p.name}`}>
                  <td className="py-1 pr-3 text-muted">{p.index}</td>
                  <td className="py-1 pr-3 font-mono">{p.name}</td>
                  <td className="py-1 pr-3 text-muted">{p.type}</td>
                  <td className="py-1 pr-3 font-mono" data-testid="param-value">
                    {show(p)}
                  </td>
                  <td className="py-1 pr-3">
                    <div className="flex items-center gap-1">
                      <Input
                        aria-label={t("params.newValueFor", { name: p.name })}
                        size="md"
                        className="w-28"
                        inputMode="decimal"
                        value={drafts[p.name] ?? ""}
                        onChange={(e) => setDrafts((d) => ({ ...d, [p.name]: e.target.value }))}
                        onKeyDown={(e) => e.key === "Enter" && void write(p.name)}
                        disabled={!reachable}
                      />
                      <Button onClick={() => void write(p.name)} disabled={!reachable || st?.kind === "busy" || !drafts[p.name]}>
                        <Upload size={12} />
                        {t("params.write")}
                      </Button>
                      <Button onClick={() => void read(p.name)} disabled={!reachable || st?.kind === "busy"}>
                        <Download size={12} />
                        {t("params.read")}
                      </Button>
                    </div>
                  </td>
                  <td className="py-1 text-xs" data-testid="param-status" data-status={st?.kind ?? ""}>
                    {st?.kind === "busy" && <span className="text-muted">{t("params.waiting")}</span>}
                    {st?.kind === "ack" && <span className="text-ok">{t(st.action === "write" ? "params.acknowledged" : "params.readOk")}</span>}
                    {st?.kind === "refused" && <span className="text-danger">{t("params.refused", { requested: st.requested, value: show(p) })}</span>}
                    {st?.kind === "error" && <span className="text-danger">{st.message}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {device && <PushPanel device={device} reachable={reachable} deviceParameters={params.map((p) => p.name)} />}
    </section>
  );
}
