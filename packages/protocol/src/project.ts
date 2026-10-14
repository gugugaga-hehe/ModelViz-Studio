import { z } from "zod";
import { ParameterMapping, ParameterType } from "./parameters.ts";

/** Version of the on-disk Project format. Bump when the layout of a Project folder changes. */
export const PROJECT_SCHEMA_VERSION = 1;

/** Name of the manifest file that marks a folder as a Project. */
export const PROJECT_MANIFEST = "project.yaml";

/** Identifiers used inside Signal names; kept simple so names stay readable and unambiguous. */
export const Identifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, "letters, digits, '_' or '-', starting with a letter");

/** How a Virtual Device synthesises one Field. */
export const FieldGenerator = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sine"),
    freqHz: z.number().positive(),
    amplitude: z.number().default(1),
    offset: z.number().default(0),
  }),
  /** value = start + step × frameIndex */
  z.object({ kind: z.literal("ramp"), start: z.number().default(0), step: z.number().default(1) }),
  z.object({ kind: z.literal("constant"), value: z.number() }),
]);
export type FieldGenerator = z.infer<typeof FieldGenerator>;

/** Deliberate imperfections a Virtual Device can introduce, for testing link handling. */
export const VirtualFaults = z.object({
  /** Skip every Nth frame (the sequence number still advances, like a lost frame). */
  dropEvery: z.number().int().min(2).optional(),
  /** Corrupt one byte of every Nth frame so its CRC fails. */
  corruptEvery: z.number().int().min(2).optional(),
  /** Delay delivery of byte chunks by a random 0..jitterMs, preserving order. */
  jitterMs: z.number().nonnegative().optional(),
});
export type VirtualFaults = z.infer<typeof VirtualFaults>;

/** One Device Parameter in a Virtual Device's simulated parameter store. */
export const VirtualParameter = z.object({
  value: z.number(),
  type: ParameterType.default("float"),
  /** Writes outside the range are refused: the Device keeps and reports its old value. */
  min: z.number().optional(),
  max: z.number().optional(),
  readOnly: z.boolean().default(false),
});
export type VirtualParameter = z.infer<typeof VirtualParameter>;

export const VirtualDeviceConfig = z.object({
  faults: VirtualFaults.default({}),
  /** Simulated Device Parameters, in enumeration order. */
  parameters: z.record(z.string(), VirtualParameter).default({}),
  /** Messages to emit, by Message name. Unlisted Messages are not emitted. */
  messages: z.record(
    z.string(),
    z.object({
      rateHz: z.number().positive().max(100_000),
      /** Per-Field generators; Fields without one get a default sine wave. */
      fields: z.record(z.string(), FieldGenerator).default({}),
    }),
  ),
});
export type VirtualDeviceConfig = z.infer<typeof VirtualDeviceConfig>;

/** The carrier of a Device's byte stream. Transports know nothing about Framing. */
export const TransportConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("serial"), path: z.string().min(1), baudRate: z.number().int().positive().default(115200) }),
  z.object({ kind: z.literal("tcp"), host: z.string().min(1), port: z.number().int().min(1).max(65535) }),
  z.object({
    kind: z.literal("udp"),
    /** Local port to receive datagrams on. */
    localPort: z.number().int().min(1).max(65535),
    remoteHost: z.string().optional(),
    remotePort: z.number().int().min(1).max(65535).optional(),
  }),
]);
export type TransportConfig = z.infer<typeof TransportConfig>;

export const DeviceConfig = z.object({
  id: Identifier,
  /** Path of the Device's Frame Format file, relative to the Project folder. */
  frameFormat: z.string().min(1),
  /** How this Device behaves when run as a Virtual Device. */
  virtual: VirtualDeviceConfig.optional(),
  /** Default Transport offered when connecting to the real Device. */
  transport: TransportConfig.optional(),
});
export type DeviceConfig = z.infer<typeof DeviceConfig>;

/** Python environment the Project's Python Blocks run in (ADR-0005). */
export const PythonConfig = z.object({
  /** Interpreter request passed to uv, e.g. "3.12". Defaults to whatever uv finds. */
  version: z.string().optional(),
  /** Requirement specifiers, e.g. "numpy>=2", "scipy". */
  dependencies: z.array(z.string()).default([]),
});
export type PythonConfig = z.infer<typeof PythonConfig>;

export const ProjectManifest = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  name: z.string().min(1),
  devices: z.array(DeviceConfig).default([]),
  python: PythonConfig.optional(),
  /** Block Parameter ↔ Device Parameter pairs used by Push. */
  parameterMappings: z.array(ParameterMapping).default([]),
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;

export const TimeUnit = z.enum(["us", "ms", "s"]);
export type TimeUnit = z.infer<typeof TimeUnit>;

/** Per-Message declarations layered on top of the Framing's own definitions. */
export const MessageOptions = z.object({
  /** Field carrying the Device Timestamp; when present it is the authoritative time for this Message's Signals. */
  deviceTimestamp: z.object({ field: z.string(), unit: TimeUnit }).optional(),
  /** Frames per second the Device should produce; used to detect dropped frames and timing jumps. */
  nominalRateHz: z.number().positive().optional(),
  /**
   * Array Fields that each carry several consecutive samples per frame. Element 0 is at the
   * Device Timestamp; element i is i sample intervals later.
   */
  batch: z
    .object({
      fields: z.array(z.string()).min(1),
      /** Fixed sample rate within a frame … */
      sampleRateHz: z.number().positive().optional(),
      /** … or a Field holding the interval between samples. */
      intervalField: z.object({ field: z.string(), unit: TimeUnit }).optional(),
    })
    .refine((b) => (b.sampleRateHz === undefined) !== (b.intervalField === undefined), {
      message: "batch needs exactly one of sampleRateHz or intervalField",
    })
    .optional(),
});
export type MessageOptions = z.infer<typeof MessageOptions>;

/** Frame Format file: a Framing plus the Messages it carries (ADR-0002). */
export const FrameFormatFile = z.discriminatedUnion("framing", [
  z.object({
    framing: z.literal("mavlink2"),
    /** MAVLink dialect XML, relative to the Frame Format file. */
    dialect: z.string().min(1),
    messages: z.record(z.string(), MessageOptions).default({}),
    /**
     * Message and Field through which the Device reports its dialect hash. When declared,
     * no telemetry is accepted until the hash matches (ADR-0009).
     */
    dialectCheck: z.object({ message: z.string(), field: z.string() }).optional(),
  }),
]);
export type FrameFormatFile = z.infer<typeof FrameFormatFile>;

/** Templates offered when creating a Project. */
export const ProjectTemplate = z.enum(["empty", "virtual-bench"]);
export type ProjectTemplate = z.infer<typeof ProjectTemplate>;

/** What the server tells clients about the currently open Project. */
export const ProjectInfo = z.object({
  path: z.string(),
  name: z.string(),
});
export type ProjectInfo = z.infer<typeof ProjectInfo>;
