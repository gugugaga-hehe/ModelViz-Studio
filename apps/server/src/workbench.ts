import {
  type DeviceConfig,
  type DeviceInfo,
  type EventData,
  type EventName,
  type MethodName,
  Methods,
  type ProjectInfo,
  type RecordingInfo,
  type ServerMessage,
  type SignalInfo,
  type SourceState,
  signalId,
} from "@modelviz/protocol";
import { WebSocket } from "ws";
import { ActiveSource, type SourceOptions } from "./active-source.ts";
import type { DeviceLink, SignalTarget } from "./device-link.ts";
import { ProtocolFailure } from "./errors.ts";
import { type FrameFormat, loadFrameFormat } from "./frame-format.ts";
import { type OpenedProject, createProject, openProject } from "./project-store.ts";
import { Recorder, RecordingReader, listRecordings } from "./recording.ts";
import { SignalBus } from "./signal-bus.ts";
import { listSerialPorts } from "./transports.ts";

interface DeviceRuntime {
  config: DeviceConfig;
  format: FrameFormat | null;
  error?: string;
  /** Signal targets for each Message's Field values. */
  signalMap: Map<string, SignalTarget[]>;
  source: ActiveSource | null;
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
          ...(d.format?.dialectCheck ? { dialectHash: d.format.dialectHash } : {}),
          ...(d.config.transport ? { transport: d.config.transport } : {}),
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
      return [...this.devices.values()].filter((d) => d.source?.active).map((d) => d.source!.state());
    },
    "source.startVirtual": async (p) => {
      const { device } = Methods["source.startVirtual"].params.parse(p);
      const d = this.idleDevice(device);
      const virtual = d.config.virtual;
      if (!virtual) throw new ProtocolFailure("invalid_project", `Device ${device} has no virtual configuration`);
      return this.startSource(d, (opts) => ActiveSource.virtual(opts, virtual));
    },
    "source.connect": async (p) => {
      const { device, transport } = Methods["source.connect"].params.parse(p);
      const d = this.idleDevice(device);
      return this.startSource(d, (opts) => ActiveSource.live(opts, transport));
    },
    "transports.listSerial": async () => listSerialPorts(),
    "source.startReplay": async (p) => {
      const { device, recording, speed } = Methods["source.startReplay"].params.parse(p);
      const d = this.idleDevice(device);
      const reader = await RecordingReader.open(this.requireProject().path, recording);
      if (reader.meta.device !== device) {
        throw new ProtocolFailure("invalid_params", `Recording ${recording} belongs to Device ${reader.meta.device}`);
      }
      return this.startSource(d, (opts) => ActiveSource.replay(opts, reader, speed));
    },
    "replay.control": async (p) => {
      const { device, action, positionMs, speed } = Methods["replay.control"].params.parse(p);
      const d = this.device(device);
      if (!d.source?.active || d.source.kind !== "replay") {
        throw new ProtocolFailure("conflict", `Device ${device} is not playing a Log Replay`);
      }
      d.source.control(action, positionMs, speed);
      return d.source.state();
    },
    "recording.start": async (p) => {
      const { device, name } = Methods["recording.start"].params.parse(p);
      const d = this.device(device);
      const src = d.source;
      if (!src?.active) throw new ProtocolFailure("conflict", `Device ${device} has no running Source to record`);
      if (src.kind === "replay") throw new ProtocolFailure("conflict", "A Log Replay cannot be recorded again");
      if (src.recorder) throw new ProtocolFailure("conflict", `Device ${device} is already recording`);
      if (d.format?.dialectCheck && !src.verifiedHash) {
        throw new ProtocolFailure("conflict", `Device ${device} has not verified its dialect yet`);
      }
      const id = name ?? `${device}-${new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "")}`;
      src.recorder = await Recorder.create(this.requireProject().path, id, {
        device,
        frameFormat: d.config.frameFormat,
        createdAt: Date.now(),
        ...(src.verifiedHash ? { dialectHash: src.verifiedHash } : {}),
      });
      const info = src.recorder.info();
      this.broadcast("recording.changed", info);
      return info;
    },
    "recording.stop": async (p) => {
      const { device } = Methods["recording.stop"].params.parse(p);
      const d = this.device(device);
      const rec = d.source?.recorder;
      if (!rec) throw new ProtocolFailure("not_found", `Device ${device} is not recording`);
      return this.finishRecording(d);
    },
    "recordings.list": async () => {
      const project = this.requireProject();
      const active = new Map(
        [...this.devices.values()].flatMap((d) => (d.source?.recorder ? [[d.source.recorder.id, d.source.recorder.info()]] : [])),
      );
      const stored = (await listRecordings(project.path)).filter((r) => !active.has(r.id));
      return [...stored, ...active.values()];
    },
    "source.stop": async (p) => {
      const { device } = Methods["source.stop"].params.parse(p);
      const d = this.device(device);
      if (!d.source) return { device, kind: "virtual", state: "stopped" } satisfies SourceState;
      d.source.stop();
      return d.source.state();
    },
  };

  /** A Device that can take a new Source: loaded Frame Format, nothing running. */
  private idleDevice(id: string): DeviceRuntime & { format: FrameFormat } {
    const d = this.device(id);
    if (d.source?.active) throw new ProtocolFailure("conflict", `Device ${id} already has a running Source`);
    if (!d.format) throw new ProtocolFailure("invalid_project", d.error ?? `Device ${id} has no Frame Format`);
    return d as DeviceRuntime & { format: FrameFormat };
  }

  private startSource(
    d: DeviceRuntime & { format: FrameFormat },
    create: (opts: SourceOptions) => ActiveSource,
  ): SourceState {
    let source: ActiveSource;
    try {
      source = create({
        device: d.config.id,
        format: d.format,
        targets: d.signalMap,
        publish: (h, t, v, host) => this.bus.publish(h, t, v, host),
        onState: (state) => {
          if ((state.state === "stopped" || state.state === "rejected") && d.source?.recorder) void this.finishRecording(d);
          this.broadcast("source.changed", state);
        },
        onReset: () => this.broadcast("signals.reset", { device: d.config.id }),
      });
    } catch (e) {
      throw new ProtocolFailure("invalid_project", (e as Error).message);
    }
    d.source = source;
    d.link = source.link;
    return source.state();
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
    for (const d of this.devices.values()) {
      if (d.source?.active && d.link) this.broadcast("link.health", d.link.health());
      if (d.source?.recorder) this.broadcast("recording.changed", d.source.recorder.info());
    }
  }

  private async finishRecording(d: DeviceRuntime): Promise<RecordingInfo> {
    const rec = d.source!.recorder!;
    d.source!.recorder = null;
    await rec.close();
    const info = rec.info();
    this.broadcast("recording.changed", info);
    return info;
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
