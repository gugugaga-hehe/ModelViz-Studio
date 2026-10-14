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
import type { SignalTarget } from "./device-link.ts";
import { type CsvTable, CsvReplaySource, csvInfo, importCsv, loadImports } from "./csv-import.ts";
import { ProtocolFailure } from "./errors.ts";
import { listBlocks, listFiles, listSystems, readProjectFile, writeLoopTemplate, writeProjectFile } from "./model/store.ts";
import { SystemEngine, SystemError, loadSystem, systemName } from "./model/system.ts";
import { compareDiscretization, discretizeBlock } from "./model/discretization-service.ts";
import { runFrequencyAnalysis, runPoleZero } from "./model/frequency-analysis.ts";
import { spectrum } from "./model/spectrum.ts";
import { type SweepControl, runSweep } from "./model/sweep.ts";
import type { PythonRuntime } from "./model/python-host.ts";
import { type SampledSignal, runTimeAnalysis, withPython } from "./model/time-analysis.ts";
import { type FrameFormat, loadFrameFormat } from "./frame-format.ts";
import { type OpenedProject, createProject, openProject, readLayout, updateManifest, writeLayout } from "./project-store.ts";
import { LiveSystem } from "./live-system.ts";
import { DeviceLink } from "./device-link.ts";
import type { ParameterClient } from "./device-parameters.ts";
import { PushService, checkMappings, resolveMappings } from "./push.ts";
import { PythonEnvironment } from "./python-env.ts";
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

/** An imported CSV: its columns are Signals and it can be played as a Log Replay. */
interface CsvImport {
  table: CsvTable;
  handles: number[];
  source: CsvReplaySource | null;
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
  private imports = new Map<string, CsvImport>();
  /** Python environment of the open Project. */
  private python: PythonEnvironment | null = null;
  /** Systems running from live Signals, by System path. */
  private readonly live = new Map<string, LiveSystem>();
  /** Long-running Analyses by client-chosen id, for cancellation. */
  private readonly jobs = new Map<string, AbortController>();
  /** Push previews waiting for confirmation. */
  private readonly push = new PushService();
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
    for (const l of this.live.values()) l.stop();
    for (const d of this.devices.values()) d.source?.stop();
    for (const i of this.imports.values()) i.source?.stop();
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
    "layout.get": async () => readLayout(this.requireProject().path),
    "layout.set": async (p) => {
      const { layout } = Methods["layout.set"].params.parse(p);
      await writeLayout(this.requireProject().path, layout);
      return {};
    },
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
      return [...this.devices.values(), ...this.imports.values()].filter((d) => d.source?.active).map((d) => d.source!.state());
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
    "parameters.list": async (p) => {
      const { device } = Methods["parameters.list"].params.parse(p);
      return { device, ...(await this.parameterClient(device).list()) };
    },
    "parameters.read": async (p) => {
      const { device, name } = Methods["parameters.read"].params.parse(p);
      return this.parameterClient(device).read(name);
    },
    "parameters.write": async (p) => {
      const { device, name, value } = Methods["parameters.write"].params.parse(p);
      return { device, requested: value, ...(await this.parameterClient(device).write(name, value)) };
    },
    "mappings.list": async () => this.mappings(),
    "mappings.set": async (p) => {
      const { mappings } = Methods["mappings.set"].params.parse(p);
      const project = this.requireProject();
      checkMappings(mappings);
      await updateManifest(project.path, (doc) => {
        doc.set("parameterMappings", doc.createNode(mappings, { flow: false }));
      });
      return this.mappings();
    },
    "push.preview": async (p) => {
      const { device } = Methods["push.preview"].params.parse(p);
      const client = this.parameterClient(device);
      return this.push.preview(device, await this.mappings(), client);
    },
    "push.apply": async (p) => {
      const { id } = Methods["push.apply"].params.parse(p);
      this.requireProject();
      const preview = this.push.take(id);
      const client = this.parameterClient(preview.device);
      return { id, device: preview.device, results: await this.push.apply(preview, await this.mappings(), client) };
    },
    "transports.listSerial": async () => listSerialPorts(),
    "csv.import": async (p) => {
      const { path, name, timeColumn, timeUnit } = Methods["csv.import"].params.parse(p);
      const project = this.requireProject();
      if (this.devices.has(name) || this.imports.has(name)) {
        throw new ProtocolFailure("already_exists", `"${name}" is already used by a Device or import`);
      }
      const table = await importCsv(project.path, path, name, timeColumn, timeUnit);
      this.addImport(table);
      this.bus.setSignals([...this.bus.list(), ...this.importSignals(table)]);
      // clients reload Signals and Recordings on this event
      this.broadcast("project.changed", project);
      return csvInfo(table);
    },
    "source.startReplay": async (p) => {
      const { device, recording, speed } = Methods["source.startReplay"].params.parse(p);
      const imp = this.imports.get(device);
      if (imp) {
        if (recording !== device) throw new ProtocolFailure("invalid_params", `Import ${device} replays only itself`);
        if (imp.source?.active) throw new ProtocolFailure("conflict", `${device} is already playing`);
        imp.source = new CsvReplaySource({
          table: imp.table,
          handles: imp.handles,
          publish: (h, t, v) => this.bus.publish(h, t, v),
          onState: (state) => this.broadcast("source.changed", state),
          onReset: () => this.broadcast("signals.reset", { device }),
          speed,
        });
        return imp.source.state();
      }
      const d = this.idleDevice(device);
      const reader = await RecordingReader.open(this.requireProject().path, recording);
      if (reader.meta.device !== device) {
        throw new ProtocolFailure("invalid_params", `Recording ${recording} belongs to Device ${reader.meta.device}`);
      }
      return this.startSource(d, (opts) => ActiveSource.replay(opts, reader, speed));
    },
    "replay.control": async (p) => {
      const { device, action, positionMs, speed } = Methods["replay.control"].params.parse(p);
      const src = this.sourceOf(device);
      if (!src?.active || src.kind !== "replay") {
        throw new ProtocolFailure("conflict", `Device ${device} is not playing a Log Replay`);
      }
      src.control(action, positionMs, speed);
      return src.state();
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
      return [...stored, ...active.values(), ...[...this.imports.values()].map((i) => csvInfo(i.table))];
    },
    "files.list": async () => listFiles(this.requireProject().path),
    "files.read": async (p) => {
      const { path } = Methods["files.read"].params.parse(p);
      return { path, content: await readProjectFile(this.requireProject().path, path) };
    },
    "files.write": async (p) => {
      const { path, content } = Methods["files.write"].params.parse(p);
      const project = this.requireProject();
      await writeProjectFile(project.path, path, content);
      // Frame Formats, Blocks and Systems shape the Signal list: reload like reopening the Project.
      if (!this.devicesBusy()) await this.setProject(await openProject(project.path));
      return { path };
    },
    "blocks.list": async () => listBlocks(this.requireProject().path),
    "systems.list": async () => listSystems(this.requireProject().path),
    "system.validate": async (p) => {
      const { system } = Methods["system.validate"].params.parse(p);
      return { issues: (await loadSystem(this.requireProject().path, system)).issues };
    },
    "system.fromLoopTemplate": async (p) => {
      const { name, sampleRateHz, controller, plant, sensor } = Methods["system.fromLoopTemplate"].params.parse(p);
      const project = this.requireProject();
      const path = await writeLoopTemplate(project.path, name, sampleRateHz, controller, plant, sensor);
      if (!this.devicesBusy()) await this.setProject(await openProject(project.path));
      return (await listSystems(project.path)).find((s) => s.path === path)!;
    },
    "block.discretize": async (p) => {
      const req = Methods["block.discretize"].params.parse(p);
      const project = this.requireProject();
      const result = await discretizeBlock(project.path, req);
      if (result.saved && !this.devicesBusy()) await this.setProject(await openProject(project.path));
      return result;
    },
    "analysis.discretization": async (p) => {
      const req = Methods["analysis.discretization"].params.parse(p);
      return compareDiscretization(this.requireProject().path, req);
    },
    "analysis.frequency": async (p) => {
      const req = Methods["analysis.frequency"].params.parse(p);
      const project = this.requireProject();
      if (!req.id) return runFrequencyAnalysis(project.path, req, this.pythonRuntime());
      return this.job(req.id, (ctl) => runFrequencyAnalysis(project.path, req, this.pythonRuntime(), ctl));
    },
    "analysis.poleZero": async (p) => runPoleZero(this.requireProject().path, Methods["analysis.poleZero"].params.parse(p)),
    "analysis.sweep": async (p) => {
      const req = Methods["analysis.sweep"].params.parse(p);
      const project = this.requireProject();
      return this.job(req.id, (ctl) => runSweep(project.path, req, ctl, this.pythonRuntime()));
    },
    "analysis.cancel": async (p) => {
      const { id } = Methods["analysis.cancel"].params.parse(p);
      const job = this.jobs.get(id);
      job?.abort();
      return { cancelled: !!job };
    },
    "analysis.spectrum": async (p) => spectrum(Methods["analysis.spectrum"].params.parse(p)),
    "analysis.time": async (p) => {
      const req = Methods["analysis.time"].params.parse(p);
      const project = this.requireProject();
      const signal = req.kind === "signal" && req.signal ? await this.recordedSignal(req.signal.recording, req.signal.signal) : null;
      const result = req.id
        ? await this.job(req.id, (ctl) => runTimeAnalysis(project.path, req, this.pythonRuntime(), signal, ctl.signal))
        : await runTimeAnalysis(project.path, req, this.pythonRuntime(), signal);
      this.publishSystemOutputs(result.system, result.times, result.series);
      return result;
    },
    "python.status": async () => {
      this.requireProject();
      return this.python!.current;
    },
    "python.configure": async (p) => {
      const config = Methods["python.configure"].params.parse(p);
      const project = this.requireProject();
      await updateManifest(project.path, (doc) => doc.set("python", { ...(config.version ? { version: config.version } : {}), dependencies: config.dependencies }));
      void this.python!.sync(config);
      return this.python!.current;
    },
    "python.sync": async () => {
      this.requireProject();
      void this.python!.sync();
      return this.python!.current;
    },
    "system.live.start": async (p) => {
      const { system, input, signal, parameters } = Methods["system.live.start"].params.parse(p);
      const project = this.requireProject();
      if (this.live.get(system)?.running) throw new ProtocolFailure("conflict", `${system} is already running live`);
      const info = this.bus.list().find((s) => s.id === signal);
      if (!info) throw new ProtocolFailure("not_found", `Unknown Signal ${signal}`);
      const sys = await loadSystem(project.path, system);
      const host = withPython(sys, this.pythonRuntime());
      let engine: SystemEngine;
      try {
        engine = new SystemEngine(sys, parameters, host ? { python: host } : {});
      } catch (e) {
        host?.close();
        throw new ProtocolFailure("invalid_system", e instanceof SystemError ? e.message : (e as Error).message);
      }
      const inp = input ?? engine.inputs[0]!;
      if (!engine.inputs.includes(inp)) {
        host?.close();
        throw new ProtocolFailure("invalid_params", `System has no input ${inp}`);
      }
      const name = systemName(system);
      const live = new LiveSystem(
        system,
        inp,
        signal,
        engine,
        host,
        (fn) => this.bus.tap(info.handle, fn),
        (out, t, v) => this.bus.publish(this.bus.handleOf(signalId(`system:${name}`, "out", out)), t, v),
        (st) => this.broadcast("system.live.changed", st),
      );
      this.live.set(system, live);
      const st = live.state();
      this.broadcast("system.live.changed", st);
      return st;
    },
    "system.live.stop": async (p) => {
      const { system } = Methods["system.live.stop"].params.parse(p);
      const live = this.live.get(system);
      if (!live) throw new ProtocolFailure("not_found", `${system} is not running live`);
      live.stop();
      this.live.delete(system);
      return live.state();
    },
    "system.live.list": async () => [...this.live.values()].map((l) => l.state()),
    "source.stop": async (p) => {
      const { device } = Methods["source.stop"].params.parse(p);
      const src = this.sourceOf(device);
      if (!src) return { device, kind: "virtual", state: "stopped" } satisfies SourceState;
      src.stop();
      return src.state();
    },
  };

  /** All samples of one Signal in a Recording (decoded with the current Frame Format) or CSV import. */
  private async recordedSignal(recording: string, signal: string): Promise<SampledSignal> {
    const project = this.requireProject();
    const imp = this.imports.get(recording);
    if (imp) {
      const col = imp.table.columns.findIndex((c) => signalId(recording, "CSV", c) === signal);
      if (col < 0) throw new ProtocolFailure("not_found", `Import ${recording} has no Signal ${signal}`);
      return { t: imp.table.times.map((ms) => ms / 1000), v: imp.table.values[col]! };
    }
    const reader = await RecordingReader.open(project.path, recording);
    const d = this.devices.get(reader.meta.device);
    if (!d?.format) throw new ProtocolFailure("invalid_project", `Recording ${recording}: Device ${reader.meta.device} has no Frame Format`);
    const info = this.bus.list().find((s) => s.id === signal && s.device === reader.meta.device);
    if (!info) throw new ProtocolFailure("not_found", `Recording ${recording} has no Signal ${signal}`);
    const times: number[] = [];
    const values: number[] = [];
    const link = new DeviceLink(reader.meta.device, d.format, d.signalMap, (h, t, v) => {
      if (h === info.handle) {
        times.push(t);
        values.push(v);
      }
    });
    for (let i = 0; i < reader.chunkCount; i += 1024) {
      for (const chunk of await reader.read(i, Math.min(reader.chunkCount, i + 1024))) link.ingest(chunk.bytes, chunk.time);
    }
    if (!times.length) throw new ProtocolFailure("not_found", `Recording ${recording} contains no samples of ${signal}`);
    const t0 = times[0]!;
    return { t: Float64Array.from(times, (t) => (t - t0) / 1000), v: Float64Array.from(values) };
  }

  /** Runs a cancellable, progress-reporting Analysis registered under a client-chosen id. */
  private async job<T>(id: string, work: (ctl: SweepControl) => Promise<T>): Promise<T> {
    if (this.jobs.has(id)) throw new ProtocolFailure("conflict", `An Analysis with id ${id} is already running`);
    let last = 0;
    const abort = new AbortController();
    const ctl: SweepControl = {
      get cancelled() {
        return abort.signal.aborted;
      },
      signal: abort.signal,
      progress: (done, total) => {
        const now = performance.now();
        if (done === total || now - last > 100) {
          last = now;
          this.broadcast("analysis.progress", { id, done, total });
        }
      },
    };
    this.jobs.set(id, abort);
    try {
      return await work(ctl);
    } finally {
      this.jobs.delete(id);
    }
  }

  /** How Python Blocks run in this Project; null until its Python environment is ready. */
  private pythonRuntime(): PythonRuntime | null {
    const python = this.python?.python;
    if (!python) return null;
    return { python, callTimeoutMs: this.python!.callTimeoutMs, onOutput: (text) => this.broadcast("python.output", { text }) };
  }

  /** Whether any Source is running (reloading the Project would interrupt it). */
  private devicesBusy(): boolean {
    return [...this.devices.values(), ...this.imports.values()].some((d) => d.source?.active);
  }

  /** System outputs become Signals `system:<name>/out.<output>`, anchored at the current time. */
  private publishSystemOutputs(systemPath: string, times: number[], series: Record<string, number[]>): void {
    const name = systemPath.replace(/^.*\//, "").replace(/\.ya?ml$/, "");
    const t0 = Date.now();
    for (const [out, values] of Object.entries(series)) {
      const handle = this.bus.handleOf(signalId(`system:${name}`, "out", out));
      for (let i = 0; i < values.length; i++) this.bus.publish(handle, t0 + times[i]! * 1000, values[i]!);
    }
  }

  /** Current Source of a Device or CSV import (throws if neither exists). */
  private sourceOf(id: string): ActiveSource | CsvReplaySource | null {
    this.requireProject();
    const imp = this.imports.get(id);
    if (imp) return imp.source;
    return this.device(id).source;
  }

  private addImport(table: CsvTable): void {
    this.imports.set(table.name, {
      table,
      handles: table.columns.map((c) => this.bus.handleOf(signalId(table.name, "CSV", c))),
      source: null,
    });
  }

  private importSignals(table: CsvTable): SignalInfo[] {
    return table.columns.map((c) => {
      const id = signalId(table.name, "CSV", c);
      return { id, device: table.name, message: "CSV", field: c, handle: this.bus.handleOf(id), timebase: "device" as const };
    });
  }

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
        onParameter: (parameter) => this.broadcast("parameters.changed", { device: d.config.id, parameter }),
      });
    } catch (e) {
      throw new ProtocolFailure("invalid_project", (e as Error).message);
    }
    d.source = source;
    d.link = source.link;
    return source.state();
  }

  /** The Project's Parameter Mappings as stored now in project.yaml, resolved to Block Parameter values. */
  private async mappings() {
    const project = this.requireProject();
    const { manifest } = await openProject(project.path);
    return resolveMappings(project.path, manifest.parameterMappings, new Set(this.devices.keys()));
  }

  /** Device Parameter access for a Device whose Source is running and can send to the Device. */
  private parameterClient(id: string): ParameterClient {
    const d = this.device(id);
    if (!d.format?.parameters) {
      throw new ProtocolFailure("invalid_project", `The Frame Format of Device ${id} cannot carry Device Parameters`);
    }
    const src = d.source;
    if (!src?.parameters || src.kind === "replay") {
      throw new ProtocolFailure("conflict", `Device ${id} needs a live or Virtual Device Source for Device Parameters`);
    }
    if (!src.canExchange) throw new ProtocolFailure("conflict", `Device ${id} is not running`);
    return src.parameters;
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
    this.push.clear();
    for (const d of this.devices.values()) d.source?.stop();
    for (const i of this.imports.values()) i.source?.stop();
    if (this.project?.path !== opened.info.path) {
      for (const l of this.live.values()) l.stop();
      this.live.clear();
    }
    this.devices = new Map();
    this.imports = new Map();
    const signals: SignalInfo[] = [];
    for (const config of opened.manifest.devices) {
      const rt: DeviceRuntime = { config, format: null, signalMap: new Map(), source: null, link: null };
      try {
        rt.format = await loadFrameFormat(opened.info.path, config.frameFormat);
      } catch (e) {
        rt.error = (e as Error).message;
      }
      for (const m of rt.format?.messages ?? []) {
        if (m.control) continue;
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
    for (const sys of await listSystems(opened.info.path)) {
      for (const out of [...sys.inputs.slice(0, 1), ...sys.outputs]) {
        const device = `system:${sys.name}`;
        const id = signalId(device, "out", out);
        signals.push({ id, device, message: "out", field: out, handle: this.bus.handleOf(id), timebase: "device" });
      }
    }
    // Unreadable imports are skipped; a broken CSV must not prevent opening the Project.
    for (const table of (await loadImports(opened.info.path)).tables) {
      if (this.devices.has(table.name)) continue;
      this.addImport(table);
      signals.push(...this.importSignals(table));
    }
    this.bus.setSignals(signals);
    // Reopening the same Project keeps its environment manager, so syncs never overlap.
    if (this.python?.projectPath !== opened.info.path) {
      this.python = new PythonEnvironment(opened.info.path, opened.manifest.python, (st) => this.broadcast("python.changed", st));
    }
    void this.python.sync(opened.manifest.python);
    this.project = opened.info;
    this.broadcast("project.changed", opened.info);
    return opened.info;
  }
}
