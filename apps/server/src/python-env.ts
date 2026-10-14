import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PythonConfig, PythonStatus } from "@modelviz/protocol";

/** Environment folder inside the Project (git-ignored; rebuilt from the lock file). */
export const VENV_DIR = ".venv";
/** Pinned requirements, diffable and committed, so the environment is reproducible (ADR-0005). */
export const LOCK_FILE = "requirements.lock";
const HASH_PREFIX = "# modelviz-dependencies: ";
const LOG_LINES = 40;

export function venvPython(projectPath: string): string {
  return process.platform === "win32" ? join(projectPath, VENV_DIR, "Scripts", "python.exe") : join(projectPath, VENV_DIR, "bin", "python");
}

function uvCommand(): string {
  return process.env.MODELVIZ_UV ?? "uv";
}

const exists = (p: string) => stat(p).then(() => true, () => false);

function declarationHash(cfg: PythonConfig): string {
  return createHash("sha256").update(JSON.stringify({ v: cfg.version ?? "", d: [...cfg.dependencies].sort() })).digest("hex").slice(0, 16);
}

/**
 * Creates and keeps in sync one isolated Python environment per Project, using uv:
 * declared dependencies → requirements.lock (pinned) → .venv. One sync runs at a time;
 * requests during a sync are coalesced into one follow-up run.
 */
export class PythonEnvironment {
  private status: PythonStatus;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    readonly projectPath: string,
    private config: PythonConfig | undefined,
    private readonly onChange: (s: PythonStatus) => void,
  ) {
    this.status = { state: config ? "preparing" : "absent", dependencies: config?.dependencies ?? [], locked: [], log: [] };
  }

  get current(): PythonStatus {
    return this.status;
  }

  get python(): string | null {
    return this.status.state === "ready" ? venvPython(this.projectPath) : null;
  }

  /** Runs a sync if needed and resolves when the environment is settled (ready, failed or absent). */
  sync(config: PythonConfig | undefined = this.config): Promise<void> {
    this.config = config;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        await this.run();
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private set(patch: Partial<PythonStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onChange(this.status);
  }

  private log(line: string): void {
    const log = [...this.status.log, line].slice(-LOG_LINES);
    this.set({ log });
  }

  private exec(args: string[], cwd = this.projectPath): Promise<string> {
    return new Promise((resolve, reject) => {
      let out = "";
      let err = "";
      let child;
      try {
        child = spawn(uvCommand(), args, { cwd, env: { ...process.env, VIRTUAL_ENV: "", UV_NO_PROGRESS: "1" } });
      } catch (e) {
        reject(e);
        return;
      }
      child.on("error", (e: NodeJS.ErrnoException) =>
        reject(new Error(e.code === "ENOENT" ? "uv was not found; install it (https://docs.astral.sh/uv/) or set MODELVIZ_UV" : e.message)),
      );
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => {
        err += d.toString();
        for (const l of d.toString().split("\n")) if (l.trim()) this.log(l.trim());
      });
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split("\n").slice(-3).join(" ") || `uv exited with ${code}`))));
    });
  }

  private async run(): Promise<void> {
    const cfg = this.config;
    if (!cfg) {
      this.set({ state: "absent", dependencies: [], locked: [], error: undefined, version: undefined });
      return;
    }
    this.set({ state: "preparing", dependencies: cfg.dependencies, error: undefined, log: [] });
    try {
      await this.ensureGitignore();
      const py = venvPython(this.projectPath);
      if (!(await exists(py))) {
        this.log(`Creating ${VENV_DIR}…`);
        await this.exec(["venv", VENV_DIR, ...(cfg.version ? ["--python", cfg.version] : [])]);
      }
      const lockPath = join(this.projectPath, LOCK_FILE);
      const hash = declarationHash(cfg);
      const lock = await readFile(lockPath, "utf8").catch(() => null);
      if (!lock || !lock.startsWith(HASH_PREFIX + hash)) {
        this.log("Resolving dependencies…");
        const dir = await mkdtemp(join(tmpdir(), "modelviz-req-"));
        try {
          const req = join(dir, "requirements.in");
          await writeFile(req, cfg.dependencies.join("\n") + "\n");
          const pinned = cfg.dependencies.length
            ? await this.exec(["pip", "compile", req, "--python", py, "--no-header", "--no-annotate"])
            : "";
          await writeFile(lockPath, `${HASH_PREFIX}${hash}\n# Generated by ModelViz Studio from project.yaml; do not edit.\n${pinned}`);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      this.log("Installing…");
      await this.exec(["pip", "sync", LOCK_FILE, "--python", py, "--allow-empty-requirements"]);
      const version = (await this.versionOf(py)).trim();
      const locked = (await readFile(lockPath, "utf8"))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));
      this.set({ state: "ready", version, locked });
    } catch (e) {
      this.set({ state: "failed", error: (e as Error).message });
    }
  }

  private versionOf(py: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const c = spawn(py, ["-c", "import platform; print(platform.python_version())"]);
      let out = "";
      c.stdout.on("data", (d: Buffer) => (out += d.toString()));
      c.on("error", reject);
      c.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${py} failed to start`))));
    });
  }

  /** Older Projects predate the environment; keep it out of version control. */
  private async ensureGitignore(): Promise<void> {
    const gi = join(this.projectPath, ".gitignore");
    const text = await readFile(gi, "utf8").catch(() => "");
    if (!text.split("\n").some((l) => l.trim() === `${VENV_DIR}/`)) {
      await appendFile(gi, `${text && !text.endsWith("\n") ? "\n" : ""}${VENV_DIR}/\n`);
    }
  }
}
