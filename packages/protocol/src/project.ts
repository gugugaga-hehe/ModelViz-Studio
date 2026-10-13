import { z } from "zod";

/** Version of the on-disk Project format. Bump when the layout of a Project folder changes. */
export const PROJECT_SCHEMA_VERSION = 1;

/** Name of the manifest file that marks a folder as a Project. */
export const PROJECT_MANIFEST = "project.yaml";

export const ProjectManifest = z.object({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  name: z.string().min(1),
});
export type ProjectManifest = z.infer<typeof ProjectManifest>;

/** What the server tells clients about the currently open Project. */
export const ProjectInfo = z.object({
  path: z.string(),
  name: z.string(),
});
export type ProjectInfo = z.infer<typeof ProjectInfo>;
