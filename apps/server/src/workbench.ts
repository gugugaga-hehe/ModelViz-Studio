import {
  type DeviceConfig,
  type DeviceInfo,
  type EventData,
  type EventName,
  type MethodName,
  Methods,
  type ProjectInfo,
  type ServerMessage,
  type SignalInfo,
  type SourceState,
  signalId,
} from "@modelviz/protocol";
import { WebSocket } from "ws";
import { DeviceLink, type SignalTarget } from "./device-link.ts";
import { ProtocolFailure } from "./errors.ts";
import { type FrameFormat, loadFrameFormat } from "./frame-format.ts";
import { type OpenedProject, createProject, openProject } from "./project-store.ts";
import { SignalBus } from "./signal-bus.ts";
import { VirtualDevice } from "./virtual-device.ts";

interface DeviceRuntime {
  config: DeviceConfig;
  format: FrameFormat | null;
  error?: string;
  /** Signal targets for each Message's Field values. */
  signalMap: Map<string, SignalTarget[]>;
  source: { kind: "virtual"; stop(): void } | null;
  /** Link of the current (or most recent) Source. */
  link: DeviceLink | null;
}

export interface RequestContext {
  ws: WebSocket;
}

type Handler = (params: unknown, ctx: RequestContext) => Promise<unknown>;

/** Server-wide state: the server is single-user, so there is one open Project. */
export class Workbench {
  project: ProjectInfo | null = null;
  readonly clients = new Set<WebSocket>();
  readonly bus = new SignalBus();
  private devices = new Map<string, DeviceRuntime>();
  private readonly healthTimer = setInterval(() => this.reportHealth(), 1000);

  broadcast<E extends EventName>(event: E, data: EventData<E>): void {
    const text = JSON.stringify({ type: "event", event, data } satisfies ServerMessage);
    for (const ws of this.clients) if (ws.readyState === WebSocket.OPEN) ws.send(text);
  }

  removeClient(ws: WebSocket): void {
    this.clients.delete(ws);
    this.bus.removeClient(ws);
  }

  close(): void {
    clearInterval(this.healthTimer);
    for (const d of this.devices.values()) d.source?.stop();
    this.bus.close();
  }

  readonly handlers: Record<MethodName, Handler> = {
    "project.create": async (p) => {
      const { path, name, template } = Methods["project.create"].params.parse(p);
      return this.setProject(await createProject(path, name, template));
    },
    "project.open": async (p) => {
      const { path } = Methods["project.open"].params.parse(p);
      return this.setProject(await openProject(path));
    },
    "project.current": async () => this.project,
    "devices.list": async () => {
      this.requireProject();
      return [...this.devices.values()].map(
        (d): DeviceInfo => ({
          id: d.config.id,
          frameFormat: d.config.frameFormat,
          virtual: d.config.virtual !== undefined,
          ...(d.error ? { error: d.error } : {}),
        }),
      );
    },
    "signals.list": async () => {
      this.requireProject();
      return this.bus.list();
    },
    "signals.subscribe": async (p, { ws }) => {
      const { ids } = Methods["signals.subscribe"].params.parse(p);
      try {
        this.bus.subscribe(ws, ids);
      } catch (e) {
        throw new ProtocolFailure("not_found", (e as Error).message);
      }
      return {};
    },
    "signals.unsubscribe": async (p, { ws }) => {
      const { ids } = Methods["signals.unsubscribe"].params.parse(p);
      this.bus.unsubscribe(ws, ids);
      return {};
    },
    "link.health": async (p) => {
      const { device } = Methods["link.health"].params.parse(p);
      const d = this.device(device);
      if (!d.link) throw new ProtocolFailure("not_found", `Device ${device} has not had a Source yet`);
      return d.link.health();
    },
    "sources.list": async () => {
      this.requireProject();
      return [...this.devices.values()].filter((d) => d.source).map((d) => this.sourceState(d));
    },
    "source.startVirtual": async (p) => {
      const { device } = Methods["source.startVirtual"].params.parse(p);
      const d = this.device(device);
      if (d.source) throw new ProtocolFailure("conflict", `Device ${device} already has a running Source`);
      if (!d.format) throw new ProtocolFailure("invalid_project", d.error ?? `Device ${device} has no Frame Format`);
      if (!d.config.virtual) throw new ProtocolFailure("invalid_project", `Device ${device} has no virtual configuration`);
      const link = new DeviceLink(d.config.id, d.format, d.signalMap, (h, t, v, host) => this.bus.publish(h, t, v, host));
      let vd: VirtualDevice;
      try {
        vd = new VirtualDevice(d.format, d.config.virtual, (bytes) => link.ingest(bytes));
      } catch (e) {
        throw new ProtocolFailure("invalid_project", (e as Error).message);
      }
      vd.start();
      d.link = link;
      d.source = { kind: "virtual", stop: () => vd.stop() };
      const state = this.sourceState(d);
      this.broadcast("source.changed", state);
      return state;
    },
    "source.stop": async (p) => {
      const { device } = Methods["source.stop"].params.parse(p);
      const d = this.device(device);
      const kind = d.source?.kind ?? "virtual";
      d.source?.stop();
      d.source = null;
      const state: SourceState = { device, kind, state: "stopped" };
      this.broadcast("source.changed", state);
      return state;
    },
  };

  private sourceState(d: DeviceRuntime): SourceState {
    return { device: d.config.id, kind: d.source?.kind ?? "virtual", state: d.source ? "running" : "stopped" };
  }

  private requireProject(): ProjectInfo {
    if (!this.project) throw new ProtocolFailure("no_project", "No Project is open");
    return this.project;
  }

  private device(id: string): DeviceRuntime {
    this.requireProject();
    const d = this.devices.get(id);
    if (!d) throw new ProtocolFailure("not_found", `Unknown Device ${id}`);
    return d;
  }

  private reportHealth(): void {
    for (const d of this.devices.values()) if (d.source && d.link) this.broadcast("link.health", d.link.health());
  }

  private async setProject(opened: OpenedProject): Promise<ProjectInfo> {
    for (const d of this.devices.values()) d.source?.stop();
    this.devices = new Map();
    const signals: SignalInfo[] = [];
    for (const config of opened.manifest.devices) {
      const rt: DeviceRuntime = { config, format: null, signalMap: new Map(), source: null, link: null };
      try {
        rt.format = await loadFrameFormat(opened.info.path, config.frameFormat);
      } catch (e) {
        rt.error = (e as Error).message;
      }
      for (const m of rt.format?.messages ?? []) {
        const targets: SignalTarget[] = [];
        const timebase = m.deviceTimestamp ? "device" : "host";
        for (const f of m.fields.filter((f) => f.numeric)) {
          const batched = m.batch?.fields.includes(f.name) ?? false;
          const names =
            f.arrayLength && !batched ? Array.from({ length: f.arrayLength }, (_, i) => `${f.name}[${i}]`) : [f.name];
          names.forEach((fieldName, index) => {
            const id = signalId(config.id, m.name, fieldName);
            const handle = this.bus.handleOf(id);
            targets.push({ field: f.name, index, handle, batched });
            signals.push({
              id,
              device: config.id,
              message: m.name,
              field: fieldName,
              handle,
              timebase,
              ...(f.units ? { units: f.units } : {}),
            });
          });
        }
        rt.signalMap.set(m.name, targets);
      }
      this.devices.set(config.id, rt);
    }
    this.bus.setSignals(signals);
    this.project = opened.info;
    this.broadcast("project.changed", opened.info);
    return opened.info;
  }
}
