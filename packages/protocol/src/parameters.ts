import { z } from "zod";

/** Storage type of a Device Parameter on the Device. */
export const ParameterType = z.enum(["uint8", "int8", "uint16", "int16", "uint32", "int32", "float"]);
export type ParameterType = z.infer<typeof ParameterType>;

/** A Device Parameter as last reported by the Device. */
export const DeviceParameter = z.object({
  name: z.string(),
  value: z.number(),
  type: ParameterType,
  /** Position in the Device's own enumeration order. */
  index: z.number().int(),
});
export type DeviceParameter = z.infer<typeof DeviceParameter>;

export const ParameterList = z.object({
  device: z.string(),
  /** Sorted by index. */
  parameters: z.array(DeviceParameter),
  /** How many Device Parameters the Device says it has. */
  count: z.number().int(),
  /** Indices the Device never reported, even after re-requesting them. */
  missing: z.array(z.number().int()),
});
export type ParameterList = z.infer<typeof ParameterList>;

export const ParameterWriteResult = z.object({
  device: z.string(),
  /** The value the Device acknowledged it now holds. */
  parameter: DeviceParameter,
  requested: z.number(),
  /** False when the Device answered with a different value, i.e. it refused the write. */
  accepted: z.boolean(),
});
export type ParameterWriteResult = z.infer<typeof ParameterWriteResult>;

/**
 * A Parameter Mapping: a Block Parameter of one Block in a System, paired with a Device
 * Parameter. Its value reaches the Device only through a Push (ADR-0008).
 */
export const ParameterMapping = z.object({
  /** System file, relative to the Project. */
  system: z.string().min(1),
  /** System Block name. */
  block: z.string().min(1),
  /** Block Parameter name. */
  parameter: z.string().min(1),
  device: z.string().min(1),
  deviceParameter: z.string().min(1),
});
export type ParameterMapping = z.infer<typeof ParameterMapping>;

export const MappingInfo = ParameterMapping.extend({
  /** The Block Parameter's value in the System (override, else the Block's default). */
  blockValue: z.number().optional(),
  /** Why the mapping cannot be used right now. */
  issue: z.string().optional(),
});
export type MappingInfo = z.infer<typeof MappingInfo>;

export const PushEntry = z.object({
  mapping: ParameterMapping,
  /** Value the Block Parameter would write. */
  proposed: z.number().nullable(),
  /** Value the Device holds now. */
  current: DeviceParameter.nullable(),
  /** changed: will be written · unchanged: Device already holds it · invalid / unavailable: not written. */
  status: z.enum(["changed", "unchanged", "invalid", "unavailable"]),
  message: z.string().optional(),
});
export type PushEntry = z.infer<typeof PushEntry>;

/** The differences a Push would write; nothing has been written yet. */
export const PushPreview = z.object({
  id: z.string(),
  device: z.string(),
  entries: z.array(PushEntry),
});
export type PushPreview = z.infer<typeof PushPreview>;

export const PushOutcome = z.object({
  mapping: ParameterMapping,
  proposed: z.number().nullable(),
  /** acknowledged: Device holds the proposed value · refused: Device kept another value · failed: no answer or error · not written: unchanged or invalid in the preview. */
  outcome: z.enum(["acknowledged", "refused", "failed", "not_written"]),
  /** Value the Device reported after the write. */
  parameter: DeviceParameter.optional(),
  message: z.string().optional(),
});
export type PushOutcome = z.infer<typeof PushOutcome>;

export const PushResult = z.object({ id: z.string(), device: z.string(), results: z.array(PushOutcome) });
export type PushResult = z.infer<typeof PushResult>;
