import { z } from "zod";

/** A number or an expression over Block Parameters (e.g. "2*zeta*wn"). */
export const Expr = z.union([z.number(), z.string().min(1)]);
export type Expr = z.infer<typeof Expr>;

export const ParameterSpec = z.object({
  default: z.number(),
  min: z.number().optional(),
  max: z.number().optional(),
  units: z.string().optional(),
  description: z.string().optional(),
});
export type ParameterSpec = z.infer<typeof ParameterSpec>;

const common = {
  description: z.string().optional(),
  parameters: z.record(z.string(), ParameterSpec).default({}),
};
const Domain = z.enum(["continuous", "discrete"]);

/** Block file: one declarative dynamic element (ADR-0003). */
export const BlockFile = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("transfer-function"),
    ...common,
    domain: Domain,
    /** Required for discrete Blocks: the rate the coefficients are designed for. */
    sampleRateHz: z.number().positive().optional(),
    /** Coefficients in descending powers of s (continuous) or z (discrete). */
    numerator: z.array(Expr).min(1),
    denominator: z.array(Expr).min(1),
    input: z.string().default("u"),
    output: z.string().default("y"),
  }),
  z.object({
    kind: z.literal("state-space"),
    ...common,
    domain: Domain,
    sampleRateHz: z.number().positive().optional(),
    A: z.array(z.array(Expr)),
    B: z.array(z.array(Expr)),
    C: z.array(z.array(Expr)),
    D: z.array(z.array(Expr)),
    inputs: z.array(z.string()).optional(),
    outputs: z.array(z.string()).optional(),
  }),
  z.object({
    kind: z.literal("difference-equation"),
    ...common,
    sampleRateHz: z.number().positive(),
    inputs: z.array(z.string()).default(["u"]),
    /** One equation per output, e.g. y: "0.9*y[n-1] + 0.1*u[n]". */
    equations: z.record(z.string(), z.string()),
    /** Declare when the equations are linear (enables analytic frequency-domain Analyses). */
    linear: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("formula"),
    ...common,
    inputs: z.array(z.string()).default(["u"]),
    /** Memoryless outputs, e.g. y: "K*u + offset"; may use t (seconds). */
    outputs: z.record(z.string(), z.string()),
    linear: z.boolean().default(false),
  }),
]);
export type BlockFile = z.infer<typeof BlockFile>;

/** A Block inside a System: a Block file with Block Parameter overrides, or a built-in. */
export const SystemBlock = z.union([
  z.object({ block: z.string().min(1), parameters: z.record(z.string(), z.number()).default({}) }),
  /** Built-in sum: one input per sign, named in1…inN; output "out". */
  z.object({ kind: z.literal("sum"), signs: z.string().regex(/^[+-]+$/) }),
  /** Built-in gain: input "u", output "y". */
  z.object({ kind: z.literal("gain"), gain: z.number() }),
]);
export type SystemBlock = z.infer<typeof SystemBlock>;

/** `block.port`, or the name of a System input. */
export const Endpoint = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/);

/** System file: a graph of Blocks joined by Connections (ADR-0004). */
export const SystemFile = z.object({
  description: z.string().optional(),
  sampleRateHz: z.number().positive(),
  inputs: z.array(z.string()).default(["r"]),
  blocks: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), SystemBlock),
  connections: z.array(z.object({ from: Endpoint, to: Endpoint })),
  /** System outputs: name → `block.port` or a System input. */
  outputs: z.record(z.string(), Endpoint),
});
export type SystemFile = z.infer<typeof SystemFile>;

export const BlockInfo = z.object({
  path: z.string(),
  kind: z.string().optional(),
  domain: Domain.optional(),
  linear: z.boolean().optional(),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  parameters: z.record(z.string(), ParameterSpec).default({}),
  error: z.string().optional(),
});
export type BlockInfo = z.infer<typeof BlockInfo>;

export const ValidationIssue = z.object({
  code: z.enum([
    "invalid_file",
    "invalid_block",
    "unknown_block",
    "unknown_port",
    "unconnected_port",
    "multiple_drivers",
    "sample_rate_mismatch",
    "algebraic_loop",
  ]),
  message: z.string(),
});
export type ValidationIssue = z.infer<typeof ValidationIssue>;

export const SystemInfo = z.object({
  path: z.string(),
  name: z.string(),
  sampleRateHz: z.number().optional(),
  inputs: z.array(z.string()).default([]),
  outputs: z.array(z.string()).default([]),
  issues: z.array(ValidationIssue),
});
export type SystemInfo = z.infer<typeof SystemInfo>;

export const Stimulus = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("step"), amplitude: z.number().default(1), startS: z.number().nonnegative().default(0) }),
  /** Unit-area pulse lasting one sample (approximates a Dirac impulse). */
  z.object({ kind: z.literal("impulse"), area: z.number().default(1) }),
  z.object({ kind: z.literal("sine"), freqHz: z.number().positive(), amplitude: z.number().default(1) }),
  /** Linear frequency sweep from f0 to f1 over the Analysis duration. */
  z.object({ kind: z.literal("chirp"), f0Hz: z.number().positive(), f1Hz: z.number().positive(), amplitude: z.number().default(1) }),
  /** Logarithmic frequency sweep from f0 to f1 over the Analysis duration. */
  z.object({ kind: z.literal("sineSweep"), f0Hz: z.number().positive(), f1Hz: z.number().positive(), amplitude: z.number().default(1) }),
]);
export type Stimulus = z.infer<typeof Stimulus>;

export const TimeAnalysisRequest = z.object({
  /** System file path, relative to the Project. */
  system: z.string(),
  kind: z.enum(["step", "impulse", "stimulus"]),
  /** Required for kind "stimulus". */
  stimulus: Stimulus.optional(),
  /** System input to drive; the other inputs are held at 0. Defaults to the first input. */
  input: z.string().optional(),
  durationS: z.number().positive().max(3600),
  /** Block Parameter overrides per System Block, applied on top of the System file. */
  parameters: z.record(z.string(), z.record(z.string(), z.number())).default({}),
});
export type TimeAnalysisRequest = z.infer<typeof TimeAnalysisRequest>;

export const TimeAnalysisResult = z.object({
  system: z.string(),
  kind: z.string(),
  input: z.string(),
  sampleRateHz: z.number(),
  /** Seconds from the start of the Analysis. */
  times: z.array(z.number()),
  /** The driving input and every System output. */
  series: z.record(z.string(), z.array(z.number())),
});
export type TimeAnalysisResult = z.infer<typeof TimeAnalysisResult>;
