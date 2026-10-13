import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RecordingInfo, ReplayState, SourceState, SourceStatus, TimeUnit } from "@modelviz/protocol";
import { parse, stringify } from "yaml";
import { ProtocolFailure } from "./errors.ts";
import { ReplayPlayer, type TimedSource } from "./replay.ts";

export const IMPORTS_DIR = "imports";
const TO_MS: Record<TimeUnit, number> = { us: 1e-3, ms: 1, s: 1e3 };

export interface CsvTable {
  name: string;
  /** Value columns (the time column excluded). */
  columns: string[];
  /** Milliseconds from the first row. */
  times: Float64Array;
  values: Float64Array[];
  bytes: number;
}

interface ImportConfig {
  file: string;
  timeColumn?: string;
  timeUnit: TimeUnit;
}

/** Parses a CSV with a header row, one time column and numeric value columns. */
export function parseCsv(name: string, text: string, timeColumn: string | undefined, timeUnit: TimeUnit): CsvTable {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) throw new ProtocolFailure("invalid_params", "CSV needs a header row and at least one data row");
  const header = lines[0]!;
  const delim = [",", ";", "\t"].sort((a, b) => header.split(b).length - header.split(a).length)[0]!;
  const names = header.split(delim).map((h) => h.trim().replace(/^"(.*)"$/, "$1"));
  const timeIdx = timeColumn === undefined ? 0 : names.indexOf(timeColumn);
  if (timeIdx < 0) throw new ProtocolFailure("invalid_params", `CSV has no column "${timeColumn}" (columns: ${names.join(", ")})`);
  if (names.length < 2) throw new ProtocolFailure("invalid_params", "CSV needs a time column and at least one value column");
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) throw new ProtocolFailure("invalid_params", `CSV column "${dup}" appears twice`);
  const valueIdx = names.map((_, i) => i).filter((i) => i !== timeIdx);

  const rows = lines.length - 1;
  const times = new Float64Array(rows);
  const values = valueIdx.map(() => new Float64Array(rows));
  let t0 = 0;
  for (let r = 0; r < rows; r++) {
    const lineNo = r + 2;
    const cells = lines[r + 1]!.split(delim);
    if (cells.length !== names.length) {
      throw new ProtocolFailure("invalid_params", `CSV line ${lineNo}: expected ${names.length} values, found ${cells.length}`);
    }
    const num = (i: number) => {
      const cell = cells[i]!.trim();
      const v = cell === "" ? Number.NaN : Number(cell);
      if (cell !== "" && !Number.isFinite(v)) {
        throw new ProtocolFailure("invalid_params", `CSV line ${lineNo}, column "${names[i]}": "${cell}" is not a number`);
      }
      return v;
    };
    const t = num(timeIdx) * TO_MS[timeUnit];
    if (!Number.isFinite(t)) throw new ProtocolFailure("invalid_params", `CSV line ${lineNo}: missing time`);
    if (r === 0) t0 = t;
    times[r] = t - t0;
    if (r > 0 && times[r]! < times[r - 1]!) throw new ProtocolFailure("invalid_params", `CSV line ${lineNo}: time goes backwards`);
    valueIdx.forEach((ci, k) => (values[k]![r] = num(ci)));
  }
  return { name, columns: valueIdx.map((i) => names[i]!), times, values, bytes: Buffer.byteLength(text) };
}

export function csvInfo(t: CsvTable): RecordingInfo {
  return {
    id: t.name,
    device: t.name,
    startedAt: 0,
    durationMs: t.times.length ? t.times[t.times.length - 1]! : 0,
    bytes: t.bytes,
    active: false,
    format: "csv",
  };
}

/** Copies a CSV into the Project after validating it, with a small YAML sidecar for its settings. */
export async function importCsv(
  projectPath: string,
  sourcePath: string,
  name: string,
  timeColumn: string | undefined,
  timeUnit: TimeUnit,
): Promise<CsvTable> {
  if (!isAbsolute(sourcePath)) throw new ProtocolFailure("invalid_params", `CSV path must be absolute: ${sourcePath}`);
  let text: string;
  try {
    text = await readFile(sourcePath, "utf8");
  } catch {
    throw new ProtocolFailure("not_found", `CSV file not found: ${sourcePath}`);
  }
  const table = parseCsv(name, text, timeColumn, timeUnit);
  const dir = join(projectPath, IMPORTS_DIR);
  await mkdir(dir, { recursive: true });
  const sidecar = join(dir, `${name}.yaml`);
  if (await stat(sidecar).then(() => true, () => false)) throw new ProtocolFailure("already_exists", `Import ${name} already exists`);
  await copyFile(sourcePath, join(dir, `${name}.csv`));
  const config: ImportConfig = { file: `${name}.csv`, ...(timeColumn ? { timeColumn } : {}), timeUnit };
  await writeFile(sidecar, `# CSV imported as a Log Replay\n${stringify(config)}`);
  return table;
}

export async function loadImports(projectPath: string): Promise<{ tables: CsvTable[]; errors: string[] }> {
  const dir = join(projectPath, IMPORTS_DIR);
  const names = await readdir(dir).catch(() => [] as string[]);
  const tables: CsvTable[] = [];
  const errors: string[] = [];
  for (const n of names.filter((x) => x.endsWith(".yaml")).sort()) {
    const name = n.slice(0, -5);
    try {
      const cfg = parse(await readFile(join(dir, n), "utf8")) as ImportConfig;
      const text = await readFile(join(dir, cfg.file), "utf8");
      tables.push(parseCsv(name, text, cfg.timeColumn, cfg.timeUnit ?? "s"));
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  return { tables, errors };
}

interface Row {
  time: number;
  row: number;
}

class CsvTimedSource implements TimedSource<Row> {
  readonly startedAt = 0;
  constructor(private readonly t: CsvTable) {}
  get id() {
    return this.t.name;
  }
  get durationMs() {
    return this.t.times.length ? this.t.times[this.t.times.length - 1]! : 0;
  }
  get chunkCount() {
    return this.t.times.length;
  }
  indexAt(pos: number): number {
    let lo = 0;
    let hi = this.t.times.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t.times[mid]! < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  async read(from: number, to: number): Promise<Row[]> {
    const out: Row[] = [];
    for (let i = from; i < to; i++) out.push({ time: this.t.times[i]!, row: i });
    return out;
  }
}

export interface CsvReplayOptions {
  table: CsvTable;
  /** Signal handle per value column. */
  handles: number[];
  publish(handle: number, time: number, value: number): void;
  onState(state: SourceState): void;
  onReset(): void;
  speed: number;
}

/** Log Replay of an imported CSV: rows are published as samples at their (relative) times. */
export class CsvReplaySource {
  readonly kind = "replay" as const;
  readonly link = null;
  recorder = null;
  readonly verifiedHash = null;
  private readonly player: ReplayPlayer<Row>;
  private status: SourceStatus = "running";
  /** Wall-clock time that row time 0 maps to. */
  private readonly anchor = Date.now();

  constructor(private readonly opts: CsvReplayOptions) {
    const { table, handles, publish } = opts;
    let last = 0;
    this.player = new ReplayPlayer(
      new CsvTimedSource(table),
      ({ time, row }) => {
        for (let c = 0; c < handles.length; c++) {
          const v = table.values[c]![row]!;
          if (!Number.isNaN(v)) publish(handles[c]!, this.anchor + time, v);
        }
        const now = performance.now();
        if (now - last > 250) {
          last = now;
          opts.onState(this.state());
        }
      },
      () => opts.onState(this.state()),
      opts.speed,
    );
    opts.onState(this.state());
    this.player.play();
  }

  get active(): boolean {
    return this.status === "running";
  }

  state(): SourceState & { replay: ReplayState } {
    return { device: this.opts.table.name, kind: "replay", state: this.status, replay: this.player.state() };
  }

  control(action: "play" | "pause" | "seek" | "speed", positionMs?: number, speed?: number): void {
    switch (action) {
      case "play":
        return this.player.play();
      case "pause":
        return this.player.pause();
      case "speed":
        if (speed) this.player.setSpeed(speed);
        return;
      case "seek":
        this.player.seek(positionMs ?? 0);
        this.opts.onReset();
        return;
    }
  }

  stop(): void {
    this.player.stop();
    this.status = "stopped";
    this.opts.onState(this.state());
  }
}
