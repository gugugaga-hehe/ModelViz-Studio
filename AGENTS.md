# AGENTS.md

## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues (`gugugaga-hehe/ModelViz-Studio`) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Development

- TypeScript monorepo (pnpm). Shared schemas live in `packages/protocol`; never duplicate them in the server or web app.
- Tests go through the two seams only: Seam A (`apps/server/test`, drive a real server via `@modelviz/client`) and Seam B (`e2e`, Playwright). Do not add module-level unit tests for internals.
- Before finishing work run `pnpm typecheck`, `pnpm test` and `pnpm test:e2e`.
- Glossary terms from `CONTEXT.md` stay in English in every UI language.
