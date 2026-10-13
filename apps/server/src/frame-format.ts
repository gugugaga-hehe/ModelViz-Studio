import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { type FieldGenerator, FrameFormatFile, type MessageOptions, type TimeUnit } from "@modelviz/protocol";
import { parse } from "yaml";
import { ProtocolFailure } from "./errors.ts";
import { type FieldValue, decodePayload, encodeFrame } from "./mavlink/codec.ts";
import { DialectError, loadDialect } from "./mavlink/dialect.ts";
import { Mavlink2Parser, type ParserStats } from "./mavlink/parser.ts";

/**
 * Framing-independent view of a Frame Format (ADR-0002). Everything outside this module
 * sees only Messages and Fields; MAVLink2 is one implementation behind it.
 */
export interface FieldSpec {
  name: string;
  /** 0 for scalars. */
  arrayLength: number;
  /** Text Fields are not turned into Signals. */
  numeric: boolean;
  integer: boolean;
  units?: string;
}

export interface MessageSpec {
  name: string;
  fields: FieldSpec[];
  /** Field holding the Device Timestamp and its scale to milliseconds. */
  deviceTimestamp?: { field: string; toMs: number };
  nominalRateHz?: number;
  /** Array Fields carrying consecutive samples; Signals for them are per-sample, not per-element. */
  batch?: {
    fields: string[];
    length: number;
    intervalMs?: number;
    intervalField?: { field: string; toMs: number };
  };
}

const TO_MS: Record<TimeUnit, number> = { us: 1e-3, ms: 1, s: 1e3 };

export interface DecodedMessage {
  message: string;
  values: Record<string, FieldValue>;
}

export interface FrameDecoder {
  push(bytes: Uint8Array): DecodedMessage[];
  readonly stats: ParserStats;
}

export interface FrameEncoder {
  encode(message: string, values: Record<string, FieldValue>): Uint8Array;
}

export interface FrameFormat {
  messages: MessageSpec[];
  createDecoder(): FrameDecoder;
  createEncoder(): FrameEncoder;
}

export async function loadFrameFormat(projectPath: string, relPath: string): Promise<FrameFormat> {
  const path = resolve(projectPath, relPath);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ProtocolFailure("invalid_project", `Frame Format not found: ${relPath}`);
  }
  const parsed = FrameFormatFile.safeParse(parse(text));
  if (!parsed.success) {
    throw new ProtocolFailure("invalid_project", `Invalid Frame Format ${relPath}: ${parsed.error.message}`);
  }
  const file = parsed.data;
  let format: FrameFormat;
  switch (file.framing) {
    case "mavlink2":
      format = await loadMavlink2(resolve(dirname(path), file.dialect));
  }
  for (const [name, opts] of Object.entries(file.messages)) {
    const spec = format.messages.find((m) => m.name === name);
    if (!spec) throw new ProtocolFailure("invalid_project", `Frame Format ${relPath}: unknown Message ${name}`);
    applyOptions(spec, opts, relPath);
  }
  return format;
}

function applyOptions(spec: MessageSpec, opts: MessageOptions, relPath: string): void {
  const fail = (msg: string) => {
    throw new ProtocolFailure("invalid_project", `Frame Format ${relPath}, Message ${spec.name}: ${msg}`);
  };
  const field = (name: string) => spec.fields.find((f) => f.name === name) ?? fail(`unknown Field ${name}`);
  if (opts.deviceTimestamp) {
    const f = field(opts.deviceTimestamp.field);
    if (!f.numeric || f.arrayLength) fail(`Device Timestamp Field ${f.name} must be a numeric scalar`);
    spec.deviceTimestamp = { field: f.name, toMs: TO_MS[opts.deviceTimestamp.unit] };
  }
  if (opts.nominalRateHz) spec.nominalRateHz = opts.nominalRateHz;
  if (opts.batch) {
    if (!spec.deviceTimestamp) fail("batched Messages need a Device Timestamp");
    const lengths = new Set(opts.batch.fields.map((n) => field(n).arrayLength));
    const [length] = [...lengths];
    if (lengths.size !== 1 || !length) fail("batch Fields must be numeric arrays of equal length");
    spec.batch = {
      fields: opts.batch.fields,
      length: length!,
      ...(opts.batch.sampleRateHz ? { intervalMs: 1000 / opts.batch.sampleRateHz } : {}),
      ...(opts.batch.intervalField
        ? { intervalField: { field: field(opts.batch.intervalField.field).name, toMs: TO_MS[opts.batch.intervalField.unit] } }
        : {}),
    };
  }
}

async function loadMavlink2(dialectPath: string): Promise<FrameFormat> {
  let dialect;
  try {
    dialect = await loadDialect(dialectPath);
  } catch (e) {
    if (e instanceof DialectError) throw new ProtocolFailure("invalid_project", e.message);
    throw e;
  }
  const messages: MessageSpec[] = dialect.messages.map((m) => ({
    name: m.name,
    fields: m.fields.map((f) => ({
      name: f.name,
      arrayLength: f.arrayLength,
      numeric: f.type !== "char",
      integer: f.type !== "float" && f.type !== "double",
      ...(f.units ? { units: f.units } : {}),
    })),
  }));
  return {
    messages,
    createDecoder() {
      const parser = new Mavlink2Parser(dialect);
      return {
        stats: parser.stats,
        push: (bytes) =>
          parser.push(bytes).map((f) => ({ message: f.message.name, values: decodePayload(f.message, f.payload) })),
      };
    },
    createEncoder() {
      let seq = 0;
      return {
        encode(message, values) {
          const def = dialect.byName.get(message);
          if (!def) throw new ProtocolFailure("invalid_project", `Unknown Message ${message}`);
          return encodeFrame(def, values, { seq: seq++ & 0xff, sysid: 1, compid: 1 });
        },
      };
    },
  };
}

/** Default Virtual Device behaviour for a Field with no configured generator. */
export function defaultGenerator(field: FieldSpec, index: number): FieldGenerator {
  return field.integer
    ? { kind: "constant", value: 0 }
    : { kind: "sine", freqHz: 0.5 * (index + 1), amplitude: 1, offset: 0 };
}
