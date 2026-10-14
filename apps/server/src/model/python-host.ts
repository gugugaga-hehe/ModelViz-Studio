import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BlockError } from "./block.ts";

const RUNNER = fileURLToPath(new URL("../../python/runner.py", import.meta.url));

interface Pending {
  resolve(v: Record<string, unknown>): void;
  reject(e: Error): void;
}

/**
 * One Python process hosting the Python Blocks of an Analysis, spoken to with JSON lines.
 * Created per run (or per Parameter Sweep) and closed afterwards.
 */
export class PythonHost {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private nextHandle = 1;
  private buffer = "";
  private stderr = "";
  private exited: Error | null = null;

  constructor(python: string) {
    this.child = spawn(python, ["-u", RUNNER], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdout.on("data", (d: Buffer) => {
      this.buffer += d.toString();
      let nl;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = this.pending.get(msg.id as number);
        if (!p) continue;
        this.pending.delete(msg.id as number);
        if (msg.ok) p.resolve(msg);
        else p.reject(new BlockError(`${msg.where}: ${msg.error}`));
      }
    });
    this.child.stderr.on("data", (d: Buffer) => (this.stderr = (this.stderr + d.toString()).slice(-2000)));
    const fail = (e: Error) => {
      this.exited = e;
      for (const p of this.pending.values()) p.reject(e);
      this.pending.clear();
    };
    this.child.on("error", (e) => fail(new BlockError(`Python could not start: ${e.message}`)));
    this.child.on("exit", (code) => fail(new BlockError(`Python exited (${code})${this.stderr ? `: ${this.stderr.trim()}` : ""}`)));
  }

  call(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.exited) return Promise.reject(this.exited);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...msg, id })}\n`);
    });
  }

  handle(): string {
    return `b${this.nextHandle++}`;
  }

  close(): void {
    this.child.stdin.end();
    this.child.kill();
  }
}

/** Runtime of one Python Block instance: chunked `process` calls (ADR-0010). */
export class PythonBlockRuntime {
  readonly feedthrough = true;
  private ready: Promise<unknown>;
  private readonly handle: string;

  constructor(
    private readonly host: PythonHost,
    readonly path: string,
    modulePath: string,
    cls: string,
    params: Record<string, number>,
    rate: number,
    readonly inputs: string[],
    readonly outputs: string[],
  ) {
    this.handle = host.handle();
    this.ready = host.call({ op: "load", handle: this.handle, path: modulePath, cls, params, rate, outputs });
    this.ready.catch(() => {});
  }

  async process(t: Float64Array, inputs: Float64Array[]): Promise<Float64Array[]> {
    try {
      await this.ready;
      const reply = await this.host.call({
        op: "process",
        handle: this.handle,
        t: Array.from(t),
        inputs: Object.fromEntries(this.inputs.map((n, i) => [n, Array.from(inputs[i]!)])),
      });
      const out = reply.outputs as Record<string, number[]>;
      return this.outputs.map((n) => Float64Array.from(out[n]!));
    } catch (e) {
      throw new BlockError(`${this.path} ${(e as Error).message}`);
    }
  }

  async reset(): Promise<void> {
    await this.ready;
    await this.host.call({ op: "reset", handle: this.handle });
  }
}
