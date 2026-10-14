import { z } from "zod";
import { LAYOUT_VERSION, LayoutRead, PanelLayout, ProjectInfo, ProjectTemplate, PythonConfig, TransportConfig } from "./project.ts";
import {
  BlockInfo,
  DiscretizationComparison,
  DiscretizationRequest,
  DiscretizationResult,
  FrequencyAnalysisRequest,
  FrequencyAnalysisResult,
  LiveSystemState,
  PoleZeroResult,
  PythonStatus,
  SpectrumRequest,
  SpectrumResult,
  SweepRequest,
  SweepResult,
  Stimulus,
  SystemInfo,
  TimeAnalysisRequest,
  TimeAnalysisResult,
  ValidationIssue,
} from "./model.ts";
import { DeviceParameter, MappingInfo, ParameterList, ParameterMapping, ParameterWriteResult, PushPreview, PushResult } from "./parameters.ts";
import { DeviceInfo, LinkHealth, RecordingInfo, SerialPortInfo, SignalInfo, SourceState } from "./signals.ts";

/**
 * Version of the client protocol. Client and server must agree exactly;
 * bump on any incompatible change to the messages below.
 */
export const PROTOCOL_VERSION = 1;

/** WebSocket path the server accepts client connections on. */
export const PROTOCOL_PATH = "/ws";

export const ErrorCode = z.enum([
  "protocol_version_mismatch",
  "bad_message",
  "unknown_method",
  "invalid_params",
  "not_found",
  "conflict",
  "already_exists",
  "invalid_project",
  "invalid_system",
  "cancelled",
  /** The Device did not answer in time. */
  "timeout",
  "no_project",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ProtocolError = z.object({
  code: ErrorCode,
  message: z.string(),
});
export type ProtocolError = z.infer<typeof ProtocolError>;

// ---- Methods (request → result) -------------------------------------------

export const Methods = {
  "project.create": {
    params: z.object({
      path: z.string().min(1),
      name: z.string().min(1),
      template: ProjectTemplate.default("empty"),
    }),
    result: ProjectInfo,
  },
  "project.open": {
    params: z.object({ path: z.string().min(1) }),
    result: ProjectInfo,
  },
  "project.current": {
    params: z.object({}),
    result: ProjectInfo.nullable(),
  },
  /** The open Project's Panel layout. */
  "layout.get": {
    params: z.object({}),
    result: LayoutRead,
  },
  /**
   * Save the Panel layout into the Project (layout.yaml), always at LAYOUT_VERSION. Fails with
   * "conflict" while the existing file is unreadable: reset it first.
   */
  "layout.set": {
    params: z.object({ layout: PanelLayout.extend({ version: z.literal(LAYOUT_VERSION) }) }),
    result: z.object({}),
  },
  /** Moves the Project's layout file aside to a backup (the next free layout.yaml.bak name). */
  "layout.reset": {
    params: z.object({}),
    /** File name of the backup in the Project folder; null when there was no layout file. */
    result: z.object({ backup: z.string().nullable() }),
  },
  "devices.list": {
    params: z.object({}),
    result: z.array(DeviceInfo),
  },
  "signals.list": {
    params: z.object({}),
    result: z.array(SignalInfo),
  },
  /** Start streaming binary chunks for these Signal ids to this client. */
  "signals.subscribe": {
    params: z.object({ ids: z.array(z.string()) }),
    result: z.object({}),
  },
  "signals.unsubscribe": {
    params: z.object({ ids: z.array(z.string()) }),
    result: z.object({}),
  },
  /** Latest link health for a Device (also pushed as `link.health` events while a Source runs). */
  "link.health": {
    params: z.object({ device: z.string() }),
    result: LinkHealth,
  },
  "sources.list": {
    params: z.object({}),
    result: z.array(SourceState),
  },
  "source.startVirtual": {
    params: z.object({ device: z.string() }),
    result: SourceState,
  },
  /** Connect to the real Device over a Transport; reconnects automatically when the link drops. */
  "source.connect": {
    params: z.object({ device: z.string(), transport: TransportConfig }),
    result: SourceState,
  },
  /**
   * Enumerate the Device Parameters of a Device whose Source is running (not a Log Replay).
   * Indices the Device does not report are re-requested before giving up on them.
   */
  "parameters.list": {
    params: z.object({ device: z.string() }),
    result: ParameterList,
  },
  /** Read one Device Parameter from the Device. */
  "parameters.read": {
    params: z.object({ device: z.string(), name: z.string().min(1) }),
    result: DeviceParameter,
  },
  /** Write one Device Parameter; resolves with the value the Device acknowledged. */
  "parameters.write": {
    params: z.object({ device: z.string(), name: z.string().min(1), value: z.number().finite() }),
    result: ParameterWriteResult,
  },
  /** The Project's Parameter Mappings, with each Block Parameter's current value. */
  "mappings.list": {
    params: z.object({}),
    result: z.array(MappingInfo),
  },
  /** Replace the Project's Parameter Mappings (stored in project.yaml). Never touches the Device. */
  "mappings.set": {
    params: z.object({ mappings: z.array(ParameterMapping) }),
    result: z.array(MappingInfo),
  },
  /**
   * First step of a Push: read the mapped Device Parameters and compare them with the Block
   * Parameters. Only reads from the Device.
   */
  "push.preview": {
    params: z.object({ device: z.string() }),
    result: PushPreview,
  },
  /**
   * Second step, after the user confirmed the preview: write exactly the previewed changes.
   * A preview can be applied once; it is refused if Block Parameters changed since.
   */
  "push.apply": {
    params: z.object({ id: z.string() }),
    result: PushResult,
  },
  "transports.listSerial": {
    params: z.object({}),
    result: z.array(SerialPortInfo),
  },
  /** Start capturing the raw byte stream of a Device's running Source. */
  "recording.start": {
    params: z.object({ device: z.string(), name: z.string().regex(/^[A-Za-z0-9_.-]+$/).optional() }),
    result: RecordingInfo,
  },
  "recording.stop": {
    params: z.object({ device: z.string() }),
    result: RecordingInfo,
  },
  "recordings.list": {
    params: z.object({}),
    result: z.array(RecordingInfo),
  },
  /**
   * Import a CSV file (absolute path on the server's machine) as a Log Replay. The file is
   * copied into the Project; its columns become Signals named `<name>/CSV.<column>`.
   */
  "csv.import": {
    params: z.object({
      path: z.string().min(1),
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
      /** Column holding time; defaults to the first column. */
      timeColumn: z.string().optional(),
      timeUnit: z.enum(["s", "ms", "us"]).default("s"),
    }),
    result: RecordingInfo,
  },
  /** Play a Recording back as a Log Replay Source, decoded with the current Frame Format. */
  "source.startReplay": {
    params: z.object({ device: z.string(), recording: z.string(), speed: z.number().positive().max(64).default(1) }),
    result: SourceState,
  },
  "replay.control": {
    params: z.object({
      device: z.string(),
      action: z.enum(["play", "pause", "seek", "speed"]),
      positionMs: z.number().nonnegative().optional(),
      speed: z.number().positive().max(64).optional(),
    }),
    result: SourceState,
  },
  /** Text files of the Project that users edit (Frame Formats, dialects, Blocks, Systems). */
  "files.list": {
    params: z.object({}),
    result: z.array(z.object({ path: z.string(), kind: z.enum(["frame-format", "dialect", "block", "system", "python", "other"]) })),
  },
  "files.read": {
    params: z.object({ path: z.string() }),
    result: z.object({ path: z.string(), content: z.string() }),
  },
  "files.write": {
    params: z.object({ path: z.string(), content: z.string() }),
    result: z.object({ path: z.string() }),
  },
  "blocks.list": {
    params: z.object({}),
    result: z.array(BlockInfo),
  },
  "systems.list": {
    params: z.object({}),
    result: z.array(SystemInfo),
  },
  "system.validate": {
    params: z.object({ system: z.string() }),
    result: z.object({ issues: z.array(ValidationIssue) }),
  },
  /** Writes a new System built from the standard feedback Loop Template. */
  "system.fromLoopTemplate": {
    params: z.object({
      name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
      sampleRateHz: z.number().positive(),
      controller: z.string(),
      plant: z.string(),
      /** Optional sensor filter in the feedback path. */
      sensor: z.string().optional(),
    }),
    result: SystemInfo,
  },
  /** Time-domain Analysis; System outputs are also published as Signals `system:<name>/out.<output>`. */
  /** FFT/PSD of a window of samples of any Signal. */
  "analysis.spectrum": {
    params: SpectrumRequest,
    result: SpectrumResult,
  },
  "analysis.time": {
    params: TimeAnalysisRequest,
    result: TimeAnalysisResult,
  },
  /** Converts a continuous Block to discrete time (Discretization), optionally saving it. */
  "block.discretize": {
    params: DiscretizationRequest,
    result: DiscretizationResult,
  },
  /** Responses of a continuous Block and its discretized version to the same input. */
  "analysis.discretization": {
    params: DiscretizationRequest.omit({ save: true }).extend({
      kind: z.enum(["step", "impulse", "stimulus"]),
      stimulus: Stimulus.optional(),
      durationS: z.number().positive().max(600),
    }),
    result: DiscretizationComparison,
  },
  /** Analytic Frequency Response of a linear System (and optionally its loop transfer and margins). */
  "analysis.frequency": {
    params: FrequencyAnalysisRequest,
    result: FrequencyAnalysisResult,
  },
  "analysis.poleZero": {
    params: z.object({
      system: z.string(),
      input: z.string().optional(),
      parameters: z.record(z.string(), z.record(z.string(), z.number())).default({}),
    }),
    result: PoleZeroResult,
  },
  /** Parameter Sweep; runs in the background, reporting `analysis.progress`, until done or cancelled. */
  "analysis.sweep": {
    params: SweepRequest,
    result: SweepResult,
  },
  /** Stops a running Analysis; its request fails with code "cancelled". */
  "analysis.cancel": {
    params: z.object({ id: z.string() }),
    result: z.object({ cancelled: z.boolean() }),
  },
  "python.status": {
    params: z.object({}),
    result: PythonStatus,
  },
  /** Declares the Project's Python environment in project.yaml and prepares it. */
  "python.configure": {
    params: PythonConfig,
    result: PythonStatus,
  },
  /** Re-creates the environment from the declaration (e.g. after a failure). */
  "python.sync": {
    params: z.object({}),
    result: PythonStatus,
  },
  /**
   * Runs a System continuously from a live Signal (chunk by chunk, ADR-0010). Outputs are
   * published as Signals `system:<name>/out.<output>` on the input Signal's time axis.
   */
  "system.live.start": {
    params: z.object({
      system: z.string(),
      input: z.string().optional(),
      signal: z.string(),
      parameters: z.record(z.string(), z.record(z.string(), z.number())).default({}),
    }),
    result: LiveSystemState,
  },
  "system.live.stop": {
    params: z.object({ system: z.string() }),
    result: LiveSystemState,
  },
  "system.live.list": {
    params: z.object({}),
    result: z.array(LiveSystemState),
  },
  "source.stop": {
    params: z.object({ device: z.string() }),
    result: SourceState,
  },
} as const;

export type MethodName = keyof typeof Methods;
export type MethodParams<M extends MethodName> = z.input<(typeof Methods)[M]["params"]>;
export type MethodResult<M extends MethodName> = z.infer<(typeof Methods)[M]["result"]>;

// ---- Events (server → client, unsolicited) --------------------------------

export const Events = {
  "project.changed": ProjectInfo.nullable(),
  "source.changed": SourceState,
  "link.health": LinkHealth,
  "recording.changed": RecordingInfo,
  /** A Device's Signals restart (e.g. a Log Replay seeked); clients should drop buffered samples. */
  "signals.reset": z.object({ device: z.string() }),
  "analysis.progress": z.object({ id: z.string(), done: z.number(), total: z.number() }),
  "python.changed": PythonStatus,
  "system.live.changed": LiveSystemState,
  /** The Device reported a Device Parameter value (answer to a read or write, or unsolicited). */
  "parameters.changed": z.object({ device: z.string(), parameter: DeviceParameter }),
} as const;

export type EventName = keyof typeof Events;
export type EventData<E extends EventName> = z.infer<(typeof Events)[E]>;

// ---- Envelopes -------------------------------------------------------------

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), protocolVersion: z.number().int() }),
  z.object({
    type: z.literal("request"),
    id: z.number().int(),
    method: z.string(),
    params: z.unknown(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const ServerMessage = z.union([
  z.object({
    type: z.literal("welcome"),
    protocolVersion: z.number().int(),
    serverVersion: z.string(),
  }),
  z.object({ type: z.literal("fatal"), error: ProtocolError }),
  z.object({ type: z.literal("response"), id: z.number().int(), result: z.unknown() }),
  z.object({ type: z.literal("response"), id: z.number().int(), error: ProtocolError }),
  z.object({ type: z.literal("event"), event: z.string(), data: z.unknown() }),
]);
export type ServerMessage =
  | { type: "welcome"; protocolVersion: number; serverVersion: string }
  | { type: "fatal"; error: ProtocolError }
  | { type: "response"; id: number; result: unknown }
  | { type: "response"; id: number; error: ProtocolError }
  | { type: "event"; event: string; data: unknown };
