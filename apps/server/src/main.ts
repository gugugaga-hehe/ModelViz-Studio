import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { startServer } from "./server.ts";

const port = Number(process.env.MODELVIZ_PORT ?? 5174);
const defaultStatic = fileURLToPath(new URL("../../web/dist", import.meta.url));
const staticDir = process.env.MODELVIZ_STATIC_DIR ?? (existsSync(defaultStatic) ? defaultStatic : undefined);
const allowedOrigins = (process.env.MODELVIZ_ALLOWED_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .filter(Boolean);

const server = await startServer({ port, staticDir, allowedOrigins });
console.log(`ModelViz Studio server listening on ${server.url}${staticDir ? "" : " (no web UI build found)"}`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => void server.close().then(() => process.exit(0)));
}
