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
  /**
   * Python Block (ADR-0003): a class in a Python file run in the Project's environment.
   * Its outputs may depend on its current inputs (direct feedthrough).
   */
  z.object({
    kind: z.literal("python"),
    ...common,
    /** Python file, relative to the Project. */
    module: z.string().min(1),
    class: z.string().default("Block"),
    inputs: z.array(z.string()).default(["u"]),
    outputs: z.array(z.string()).default(["y"]),
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
  /** Python Blocks: the module file, relative to the Project. */
  module: z.string().optional(),
  kind: z.string().optional(),
  /** "python": runs at the System rate in the Project's Python environment. */
  domain: z.enum(["continuous", "discrete", "python"]).optional(),
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
  /** All Blocks are linear (so an analytic Frequency Response exists). */
  linear: z.boolean().default(false),
  /** Every Block input Port (`block.port`), e.g. for choosing where to break a loop. */
  ports: z.array(z.string()).default([]),
  /** Block Parameters available for sweeps and overrides, per System Block. */
  parameters: z.record(z.string(), z.record(z.string(), ParameterSpec)).default({}),
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

/** Metrics of a step response, relative to its final value. */
export const StepMetrics = z.object({
  finalValue: z.number(),
  /** Percent above the final value (0 if never exceeded). */
  overshootPercent: z.number(),
  /** 10 % → 90 % of the final value, seconds. */
  riseTimeS: z.number().nullable(),
  /** Last time the response leaves the ±2 % band, seconds. */
  settlingTimeS: z.number().nullable(),
  peakTimeS: z.number(),
});
export type StepMetrics = z.infer<typeof StepMetrics>;

export const TimeAnalysisResult = z.object({
  system: z.string(),
  kind: z.string(),
  input: z.string(),
  sampleRateHz: z.number(),
  /** Seconds from the start of the Analysis. */
  times: z.array(z.number()),
  /** The driving input and every System output. */
  series: z.record(z.string(), z.array(z.number())),
  /** Step responses only: Metrics per System output. */
  metrics: z.record(z.string(), StepMetrics).optional(),
});
export type TimeAnalysisResult = z.infer<typeof TimeAnalysisResult>;

export const DiscretizationRequest = z.object({
  /** Continuous Block file to convert. */
  block: z.string(),
  method: z.enum(["zoh", "tustin"]),
  sampleRateHz: z.number().positive(),
  /** Tustin only: frequency at which the discrete response matches the continuous one exactly. */
  prewarpHz: z.number().positive().optional(),
  parameters: z.record(z.string(), z.number()).default({}),
  /** Write the discrete Block to this Project path (e.g. blocks/lpf-1k.yaml). */
  save: z.string().optional(),
});
export type DiscretizationRequest = z.infer<typeof DiscretizationRequest>;

export const DiscretizationResult = z.object({
  method: z.enum(["zoh", "tustin"]),
  sampleRateHz: z.number(),
  /** Descending powers of z (SISO Blocks). */
  numerator: z.array(z.number()).optional(),
  denominator: z.array(z.number()).optional(),
  /** Discrete state-space matrices (always provided). */
  A: z.array(z.array(z.number())),
  B: z.array(z.array(z.number())),
  C: z.array(z.array(z.number())),
  D: z.array(z.array(z.number())),
  saved: z.string().optional(),
});
export type DiscretizationResult = z.infer<typeof DiscretizationResult>;

export const DiscretizationComparison = z.object({
  times: z.array(z.number()),
  input: z.array(z.number()),
  continuous: z.array(z.number()),
  discrete: z.array(z.number()),
  maxAbsError: z.number(),
});
export type DiscretizationComparison = z.infer<typeof DiscretizationComparison>;

export const Complex = z.object({ re: z.number(), im: z.number() });
export type Complex = z.infer<typeof Complex>;

export const FrequencyAnalysisRequest = z.object({
  system: z.string(),
  input: z.string().optional(),
  fMinHz: z.number().positive().optional(),
  fMaxHz: z.number().positive().optional(),
  points: z.number().int().min(2).max(5000).default(400),
  parameters: z.record(z.string(), z.record(z.string(), z.number())).default({}),
  /** Also compute the loop transfer broken at this input Port (e.g. "plant.u") and its margins. */
  openLoopAt: z.string().optional(),
  /**
   * analytic: from the linear model; measured: simulate stepped sines and estimate the
   * response (works for nonlinear Systems); auto: analytic when possible, else measured.
   */
  method: z.enum(["auto", "analytic", "measured"]).default("auto"),
  /** Measured only: sine amplitude (matters for nonlinear Systems). */
  amplitude: z.number().positive().default(1),
  /** Measured only: id for `analysis.progress` events and `analysis.cancel`. */
  id: z.string().optional(),
});
export type FrequencyAnalysisRequest = z.infer<typeof FrequencyAnalysisRequest>;

export const FrequencyMetrics = z.object({
  dcGainDb: z.number().nullable(),
  /** First frequency where the gain falls to 1/√2 (≈ −3 dB) of its DC value. */
  bandwidthHz: z.number().nullable(),
  peakGainDb: z.number(),
  peakHz: z.number(),
});
export type FrequencyMetrics = z.infer<typeof FrequencyMetrics>;

export const BodeData = z.object({ magnitudeDb: z.array(z.number()), phaseDeg: z.array(z.number()) });
export type BodeData = z.infer<typeof BodeData>;

export const LoopMetrics = z.object({
  gainMarginDb: z.number().nullable(),
  phaseCrossoverHz: z.number().nullable(),
  phaseMarginDeg: z.number().nullable(),
  gainCrossoverHz: z.number().nullable(),
});
export type LoopMetrics = z.infer<typeof LoopMetrics>;

export const FrequencyAnalysisResult = z.object({
  system: z.string(),
  input: z.string(),
  /** Always stated (ADR: a Frequency Response is analytic or measured). */
  method: z.enum(["analytic", "measured"]),
  /** continuous: H(jω); discrete: H(e^{jωT}) with continuous Blocks held by ZOH. */
  domain: z.enum(["continuous", "discrete"]),
  frequencies: z.array(z.number()),
  responses: z.record(z.string(), BodeData),
  metrics: z.record(z.string(), FrequencyMetrics),
  loop: BodeData.extend({ at: z.string() }).merge(LoopMetrics).optional(),
});
export type FrequencyAnalysisResult = z.infer<typeof FrequencyAnalysisResult>;

export const PoleZeroResult = z.object({
  system: z.string(),
  input: z.string(),
  domain: z.enum(["continuous", "discrete"]),
  poles: z.array(Complex),
  /** Zeros of the transfer from the input to each System output. */
  zeros: z.record(z.string(), z.array(Complex)),
  stable: z.boolean(),
});
export type PoleZeroResult = z.infer<typeof PoleZeroResult>;

export const SweepAxis = z.object({
  block: z.string(),
  parameter: z.string(),
  from: z.number(),
  to: z.number(),
  steps: z.number().int().min(2).max(200),
  scale: z.enum(["linear", "log"]).default("linear"),
});
export type SweepAxis = z.infer<typeof SweepAxis>;

export const StepMetricName = z.enum(["finalValue", "overshootPercent", "riseTimeS", "settlingTimeS", "peakTimeS"]);
export const FrequencyMetricName = z.enum(["dcGainDb", "bandwidthHz", "peakGainDb", "peakHz"]);
export const LoopMetricName = z.enum(["gainMarginDb", "phaseMarginDeg", "gainCrossoverHz", "phaseCrossoverHz"]);

/** Which Metrics to record at each point of a Parameter Sweep. */
export const SweepMetrics = z.object({
  /** System output the step/frequency Metrics refer to. */
  output: z.string(),
  step: z.array(StepMetricName).default([]),
  frequency: z.array(FrequencyMetricName).default([]),
  /** Loop Metrics need `openLoopAt`. */
  loop: z.array(LoopMetricName).default([]),
  openLoopAt: z.string().optional(),
  /** Step response length for step Metrics. */
  durationS: z.number().positive().max(600).default(1),
});
export type SweepMetrics = z.infer<typeof SweepMetrics>;

export const SweepRequest = z.object({
  /** Client-chosen id, used for progress events and cancellation. */
  id: z.string().min(1),
  system: z.string(),
  axes: z.array(SweepAxis).min(1).max(2),
  metrics: SweepMetrics,
  parameters: z.record(z.string(), z.record(z.string(), z.number())).default({}),
});
export type SweepRequest = z.infer<typeof SweepRequest>;

export const SweepResult = z.object({
  id: z.string(),
  system: z.string(),
  axes: z.array(SweepAxis.extend({ values: z.array(z.number()) })),
  /**
   * Metric name → values: a list for 1-D sweeps, rows indexed by the first axis for 2-D.
   * `null` where the Metric is undefined (e.g. no crossover, unstable, simulation failed).
   */
  values: z.record(z.string(), z.union([z.array(z.number().nullable()), z.array(z.array(z.number().nullable()))])),
});
export type SweepResult = z.infer<typeof SweepResult>;

export const PythonStatus = z.object({
  /** absent: the Project declares no Python environment. */
  state: z.enum(["absent", "preparing", "ready", "failed"]),
  /** Interpreter version once ready, e.g. "3.12.3". */
  version: z.string().optional(),
  dependencies: z.array(z.string()).default([]),
  /** Pinned packages from the lock file. */
  locked: z.array(z.string()).default([]),
  error: z.string().optional(),
  /** Recent output of the environment tooling, newest last. */
  log: z.array(z.string()).default([]),
});
export type PythonStatus = z.infer<typeof PythonStatus>;
