# ModelViz Studio

A debugging and analysis workbench for embedded control firmware: a browser UI backed by a local Node.js server that talks to your Device, decodes its telemetry, and lets you analyse filters, controllers and Plants in time and frequency domains.

Vocabulary is defined in [CONTEXT.md](CONTEXT.md); architectural decisions live in [docs/adr](docs/adr).

## Requirements

- Node.js ≥ 22.12
- pnpm 12

## Getting started

```bash
pnpm install
pnpm dev        # server on :5174 (watch mode) + web UI on http://localhost:5173
```

Production-style run (server serves the built UI on http://127.0.0.1:5174):

```bash
pnpm build
pnpm start
```

The server only binds to loopback and only accepts WebSocket connections from its own UI origin (plus the dev server origin). Configure with `MODELVIZ_PORT`, `MODELVIZ_STATIC_DIR` and `MODELVIZ_ALLOWED_ORIGINS`.

## Repository layout

| Package | Purpose |
|---|---|
| `packages/protocol` | Shared schemas and the versioned client protocol |
| `packages/client` | Typed protocol client used by the web app and by tests |
| `apps/server` | Local Node.js server: Projects, Devices, Signals, Analyses |
| `apps/web` | React web UI |
| `e2e` | Browser smoke tests |

## Testing

```bash
pnpm typecheck
pnpm test       # Seam A: drives a real server through the client protocol
pnpm test:e2e   # Seam B: Playwright smoke tests against the built UI
```
