import type { DeviceInfo, SerialPortInfo, TransportConfig } from "@modelviz/protocol";
import { RefreshCw } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { client } from "../state/session";

const BAUD_RATES = [57600, 115200, 230400, 460800, 921600, 1500000, 2000000];

export function ConnectForm({ device, onDone }: { device: DeviceInfo; onDone: () => void }) {
  const { t } = useTranslation();
  const initial = device.transport;
  const [kind, setKind] = useState<TransportConfig["kind"]>(initial?.kind ?? "serial");
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [path, setPath] = useState(initial?.kind === "serial" ? initial.path : "");
  const [baudRate, setBaudRate] = useState(initial?.kind === "serial" ? initial.baudRate : 115200);
  const [host, setHost] = useState(initial?.kind === "tcp" ? initial.host : "127.0.0.1");
  const [port, setPort] = useState(initial?.kind === "tcp" ? String(initial.port) : "5760");
  const [localPort, setLocalPort] = useState(initial?.kind === "udp" ? String(initial.localPort) : "14550");
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    client.request("transports.listSerial", {}).then(
      (list) => {
        setPorts(list);
        setPath((p) => p || list[0]?.path || "");
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    if (kind === "serial") void refresh();
  }, [kind]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const transport: TransportConfig =
      kind === "serial"
        ? { kind, path, baudRate }
        : kind === "tcp"
          ? { kind, host, port: Number(port) }
          : { kind, localPort: Number(localPort) };
    try {
      await client.request("source.connect", { device: device.id, transport });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const input = "w-full rounded border border-border bg-surface px-2 py-1 text-xs";
  return (
    <form onSubmit={submit} className="mt-2 flex flex-col gap-2 text-xs" aria-label={t("connect.title")}>
      <label className="flex flex-col gap-1">
        {t("connect.transport")}
        <select className={input} value={kind} onChange={(e) => setKind(e.target.value as TransportConfig["kind"])}>
          <option value="serial">{t("connect.serial")}</option>
          <option value="tcp">TCP</option>
          <option value="udp">UDP</option>
        </select>
      </label>
      {kind === "serial" && (
        <>
          <div className="flex items-end gap-1">
            <label className="flex flex-1 flex-col gap-1">
              {t("connect.port")}
              <select className={input} value={path} onChange={(e) => setPath(e.target.value)} required>
                {path && !ports.some((p) => p.path === path) && <option value={path}>{path}</option>}
                {ports.map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.path}
                    {p.manufacturer ? ` — ${p.manufacturer}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={() => void refresh()} className="rounded border border-border p-1.5" aria-label={t("connect.refresh")}>
              <RefreshCw size={12} />
            </button>
          </div>
          <label className="flex flex-col gap-1">
            {t("connect.baudRate")}
            <select className={input} value={baudRate} onChange={(e) => setBaudRate(Number(e.target.value))}>
              {[...new Set([...BAUD_RATES, baudRate])].sort((a, b) => a - b).map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {kind === "tcp" && (
        <div className="flex gap-1">
          <label className="flex flex-[2] flex-col gap-1">
            {t("connect.host")}
            <input className={input} value={host} onChange={(e) => setHost(e.target.value)} required />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            {t("connect.tcpPort")}
            <input className={input} value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" required />
          </label>
        </div>
      )}
      {kind === "udp" && (
        <label className="flex flex-col gap-1">
          {t("connect.localPort")}
          <input className={input} value={localPort} onChange={(e) => setLocalPort(e.target.value)} inputMode="numeric" required />
        </label>
      )}
      <div className="flex gap-1">
        <button type="submit" className="flex-1 rounded bg-accent px-2 py-1 font-medium text-white">
          {t("connect.connect")}
        </button>
        <button type="button" onClick={onDone} className="rounded border border-border px-2 py-1">
          {t("connect.cancel")}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
