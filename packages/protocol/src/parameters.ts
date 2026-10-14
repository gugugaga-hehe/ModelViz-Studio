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
