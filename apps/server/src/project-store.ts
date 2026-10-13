import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PROJECT_MANIFEST, PROJECT_SCHEMA_VERSION, ProjectManifest, type ProjectInfo } from "@modelviz/protocol";
import { parse, stringify } from "yaml";
import { ProtocolFailure } from "./errors.ts";

/** Recordings are binary and large; keep them out of version control by default. */
const PROJECT_GITIGNORE = "recordings/\n";

function resolveProjectPath(input: string): string {
  const expanded = input === "~" || input.startsWith("~/") ? join(homedir(), input.slice(1)) : input;
  if (!isAbsolute(expanded)) {
    throw new ProtocolFailure("invalid_params", `Project path must be absolute: ${input}`);
  }
  return resolve(expanded);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export async function createProject(pathInput: string, name: string): Promise<ProjectInfo> {
  const path = resolveProjectPath(pathInput);
  if (await exists(path)) {
    const s = await stat(path);
    if (!s.isDirectory() || (await readdir(path)).length > 0) {
      throw new ProtocolFailure("already_exists", `Project folder must be new or empty: ${path}`);
    }
  }
  await mkdir(path, { recursive: true });
  const manifest: ProjectManifest = { schemaVersion: PROJECT_SCHEMA_VERSION, name };
  await writeFile(join(path, PROJECT_MANIFEST), stringify(manifest));
  await writeFile(join(path, ".gitignore"), PROJECT_GITIGNORE);
  return { path, name };
}

export async function openProject(pathInput: string): Promise<ProjectInfo> {
  const path = resolveProjectPath(pathInput);
  const manifestPath = join(path, PROJECT_MANIFEST);
  let text: string;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch {
    throw new ProtocolFailure("not_found", `No Project found at ${path} (missing ${PROJECT_MANIFEST})`);
  }
  const parsed = ProjectManifest.safeParse(parse(text));
  if (!parsed.success) {
    throw new ProtocolFailure("invalid_project", `Invalid ${PROJECT_MANIFEST}: ${parsed.error.message}`);
  }
  return { path, name: parsed.data.name };
}
