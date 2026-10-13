import { z } from "zod";

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

export const VirtualDeviceConfig = z.object({
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

export const DeviceConfig = z.object({
  id: Identifier,
  /** Path of the Device's Frame Format file, relative to the Project folder. */
  frameFormat: z.string().min(1),
  /** How this Device behaves when run as a Virtual Device. */
  virtual: VirtualDeviceConfig.optional(),
});
export type DeviceConfig = z.infer<typeof DeviceConfig>;

export const ProjectManifest = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  name: z.string().min(1),
  devices: z.array(DeviceConfig).default([]),
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;

/** Frame Format file: a Framing plus the Messages it carries (ADR-0002). */
export const FrameFormatFile = z.discriminatedUnion("framing", [
  z.object({
    framing: z.literal("mavlink2"),
    /** MAVLink dialect XML, relative to the Frame Format file. */
    dialect: z.string().min(1),
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
