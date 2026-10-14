import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { LAYOUT_FILE, LAYOUT_VERSION, type LayoutRead, PROJECT_MANIFEST, PROJECT_SCHEMA_VERSION, PanelLayout, ProjectManifest, type ProjectInfo, type ProjectTemplate } from "@modelviz/protocol";
import { type Document, parse, parseDocument, stringify } from "yaml";
import { ProtocolFailure } from "./errors.ts";
import { templateFiles, writeTemplate } from "./templates.ts";

/** Recordings are binary and large, and the Python environment is rebuilt from its lock file. */
export const PROJECT_GITIGNORE = "recordings/\n.venv/\n";

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

export interface OpenedProject {
  info: ProjectInfo;
  manifest: ProjectManifest;
}

export async function createProject(pathInput: string, name: string, template: ProjectTemplate): Promise<OpenedProject> {
  const path = resolveProjectPath(pathInput);
  if (await exists(path)) {
    const s = await stat(path);
    if (!s.isDirectory() || (await readdir(path)).length > 0) {
      throw new ProtocolFailure("already_exists", `Project folder must be new or empty: ${path}`);
    }
  }
  await mkdir(path, { recursive: true });
  const { manifestExtra, files } = templateFiles(template);
  await writeFile(
    join(path, PROJECT_MANIFEST),
    stringify({ schemaVersion: PROJECT_SCHEMA_VERSION, name }) + manifestExtra,
  );
  await writeFile(join(path, ".gitignore"), PROJECT_GITIGNORE);
  await writeTemplate(path, files);
  return openProject(path);
}

export async function openProject(pathInput: string): Promise<OpenedProject> {
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
  const ids = parsed.data.devices.map((d) => d.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new ProtocolFailure("invalid_project", `Device id "${dup}" is used more than once`);
  return { info: { path, name: parsed.data.name }, manifest: parsed.data };
}

/** Edits project.yaml in place, preserving comments and formatting elsewhere. */
export async function updateManifest(projectPath: string, edit: (doc: Document) => void): Promise<void> {
  const path = join(projectPath, PROJECT_MANIFEST);
  const doc = parseDocument(await readFile(path, "utf8"));
  edit(doc);
  await writeFile(path, doc.toString());
}

/** The Project's Panel layout, or why the layout file there cannot be used. */
export async function readLayout(projectPath: string): Promise<LayoutRead> {
  let text: string;
  try {
    text = await readFile(join(projectPath, LAYOUT_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { status: "none" };
    return { status: "unreadable", reason: (e as Error).message };
  }
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    return { status: "unreadable", reason: `${LAYOUT_FILE} is not valid YAML: ${(e as Error).message.split("\n")[0]}` };
  }
  const parsed = PanelLayout.safeParse(data);
  if (!parsed.success) return { status: "unreadable", reason: `${LAYOUT_FILE} is not a Panel layout` };
  if (parsed.data.version > LAYOUT_VERSION) {
    return { status: "unreadable", reason: `${LAYOUT_FILE} was saved by a newer ModelViz Studio (layout version ${parsed.data.version})` };
  }
  return { status: "ok", layout: parsed.data };
}

/** Saves the layout; refuses to replace a layout file that exists but cannot be read. */
export async function writeLayout(projectPath: string, layout: PanelLayout): Promise<void> {
  const current = await readLayout(projectPath);
  if (current.status === "unreadable") {
    throw new ProtocolFailure("conflict", `${current.reason}; reset the layout before saving a new one`);
  }
  const header = "# Panel layout of this Project, saved by ModelViz Studio.\n";
  await writeFile(join(projectPath, LAYOUT_FILE), header + stringify(layout));
}

/** Moves the layout file aside to the next free `layout.yaml.bak[.N]`; returns that name, or null without a file. */
export async function resetLayout(projectPath: string): Promise<string | null> {
  if (!(await exists(join(projectPath, LAYOUT_FILE)))) return null;
  for (let n = 1; ; n++) {
    const backup = `${LAYOUT_FILE}.bak${n === 1 ? "" : `.${n}`}`;
    if (await exists(join(projectPath, backup))) continue;
    await rename(join(projectPath, LAYOUT_FILE), join(projectPath, backup));
    return backup;
  }
}
