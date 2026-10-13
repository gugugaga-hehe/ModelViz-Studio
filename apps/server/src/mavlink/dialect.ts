import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { XMLParser } from "fast-xml-parser";
import { crcAccumulate, crcString } from "./crc.ts";

export type ScalarType =
  | "char"
  | "uint8_t"
  | "int8_t"
  | "uint16_t"
  | "int16_t"
  | "uint32_t"
  | "int32_t"
  | "uint64_t"
  | "int64_t"
  | "float"
  | "double";

export const TYPE_SIZE: Record<ScalarType, number> = {
  char: 1,
  uint8_t: 1,
  int8_t: 1,
  uint16_t: 2,
  int16_t: 2,
  uint32_t: 4,
  int32_t: 4,
  uint64_t: 8,
  int64_t: 8,
  float: 4,
  double: 8,
};

export interface FieldDef {
  name: string;
  type: ScalarType;
  /** Array length, or 0 for a scalar. */
  arrayLength: number;
  units?: string;
  /** Byte offset inside the (untruncated) payload. */
  offset: number;
  extension: boolean;
}

export interface MessageDef {
  id: number;
  name: string;
  /** Fields in wire order: base fields sorted by element size (stable), then extensions. */
  fields: FieldDef[];
  /** Full payload length including extensions. */
  payloadLength: number;
  crcExtra: number;
}

export interface Dialect {
  messages: MessageDef[];
  byId: Map<number, MessageDef>;
  byName: Map<string, MessageDef>;
}

export class DialectError extends Error {}

interface RawField {
  "@_type": string;
  "@_name": string;
  "@_units"?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => ["message", "field", "include", "extensions"].includes(name),
  preserveOrder: true,
});

/** Loads a MAVLink dialect XML file, following `<include>`s relative to each file. */
export async function loadDialect(path: string): Promise<Dialect> {
  const messages = new Map<number, MessageDef>();
  await loadInto(resolve(path), messages, new Set());
  const list = [...messages.values()].sort((a, b) => a.id - b.id);
  return { messages: list, byId: messages, byName: new Map(list.map((m) => [m.name, m])) };
}

type Node = Record<string, unknown> & { ":@"?: Record<string, string> };

function children(node: Node, tag: string): Node[] {
  const list = node[tag];
  return Array.isArray(list) ? (list as Node[]) : [];
}

function textOf(node: Node): string {
  const kids = (node as Record<string, unknown>)[Object.keys(node).find((k) => k !== ":@")!];
  if (!Array.isArray(kids)) return "";
  return kids.map((k: Record<string, unknown>) => String(k["#text"] ?? "")).join("").trim();
}

async function loadInto(path: string, out: Map<number, MessageDef>, seen: Set<string>): Promise<void> {
  if (seen.has(path)) return;
  seen.add(path);
  let xml: string;
  try {
    xml = await readFile(path, "utf8");
  } catch {
    throw new DialectError(`Dialect file not found: ${path}`);
  }
  const doc = parser.parse(xml) as Node[];
  const root = doc.find((n) => "mavlink" in n);
  if (!root) throw new DialectError(`Not a MAVLink dialect (no <mavlink> root): ${path}`);
  const top = children(root, "mavlink");
  for (const inc of top.filter((n) => "include" in n)) {
    await loadInto(resolve(dirname(path), textOf(inc)), out, seen);
  }
  for (const msgsNode of top.filter((n) => "messages" in n)) {
    for (const msgNode of children(msgsNode, "messages").filter((n) => "message" in n)) {
      const def = parseMessage(msgNode, path);
      const existing = out.get(def.id);
      if (existing && existing.name !== def.name) {
        throw new DialectError(`Message id ${def.id} defined twice (${existing.name}, ${def.name})`);
      }
      out.set(def.id, def);
    }
  }
}

function parseMessage(node: Node, path: string): MessageDef {
  const attrs = node[":@"] ?? {};
  const name = attrs["@_name"];
  const id = Number(attrs["@_id"]);
  if (!name || !Number.isInteger(id) || id < 0 || id > 0xffffff) {
    throw new DialectError(`Invalid <message> in ${path}`);
  }
  const base: Omit<FieldDef, "offset">[] = [];
  const ext: Omit<FieldDef, "offset">[] = [];
  let inExtensions = false;
  for (const child of children(node, "message")) {
    if ("extensions" in child) inExtensions = true;
    if (!("field" in child)) continue;
    const a = (child[":@"] ?? {}) as unknown as RawField;
    const f = parseField(a, name);
    (inExtensions ? ext : base).push({ ...f, extension: inExtensions });
  }
  // Wire order: base fields by element size, largest first, stable for equal sizes.
  const ordered = base
    .map((f, i) => ({ f, i }))
    .sort((x, y) => TYPE_SIZE[y.f.type] - TYPE_SIZE[x.f.type] || x.i - y.i)
    .map((x) => x.f);

  let crc = crcString(`${name} `);
  for (const f of ordered) {
    crc = crcString(`${f.type} ${f.name} `, crc);
    if (f.arrayLength) crc = crcAccumulate(f.arrayLength, crc);
  }
  const crcExtra = ((crc & 0xff) ^ (crc >> 8)) & 0xff;

  let offset = 0;
  const fields: FieldDef[] = [...ordered, ...ext].map((f) => {
    const fd = { ...f, offset };
    offset += TYPE_SIZE[f.type] * Math.max(1, f.arrayLength);
    return fd;
  });
  if (offset > 255) throw new DialectError(`Message ${name} payload exceeds 255 bytes`);
  return { id, name, fields, payloadLength: offset, crcExtra };
}

function parseField(a: RawField, message: string): Omit<FieldDef, "offset" | "extension"> {
  const m = /^([a-z0-9_]+?)(?:\[(\d+)\])?$/.exec(a["@_type"] ?? "");
  if (!m || !a["@_name"]) throw new DialectError(`Invalid field in ${message}`);
  let type = m[1]!;
  if (type === "uint8_t_mavlink_version") type = "uint8_t";
  if (!(type in TYPE_SIZE)) throw new DialectError(`Unknown field type ${a["@_type"]} in ${message}`);
  return {
    name: a["@_name"],
    type: type as ScalarType,
    arrayLength: m[2] ? Number(m[2]) : 0,
    ...(a["@_units"] ? { units: a["@_units"] } : {}),
  };
}

/**
 * Dialect fingerprint the Device must report (ADR-0009): FNV-1a 32-bit over one line per
 * Message, sorted by id: "<id> <NAME> <crcExtra> <payloadLength>\n". It changes whenever a
 * Message is added, removed, renamed, or its fields change (including extensions).
 * Returned as 8 lowercase hex digits; firmware sends the same value as an unsigned integer.
 */
export function dialectHash(dialect: Dialect): string {
  let h = 0x811c9dc5;
  for (const m of dialect.messages) {
    const line = `${m.id} ${m.name} ${m.crcExtra} ${m.payloadLength}\n`;
    for (let i = 0; i < line.length; i++) {
      h ^= line.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h.toString(16).padStart(8, "0");
}
