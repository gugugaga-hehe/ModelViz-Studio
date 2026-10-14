# Handoff: MVP implementation progress

Spec: gugugaga-hehe/ModelViz-Studio#1 (tickets #2–#21, all `ready-for-agent`).

## State

- **Done (one stacked PR per ticket, none merged yet):** #2–#16 → PRs #22–#36.
  Each branch `issue-<n>-…` is based on the previous ticket's branch; PR #N targets the previous branch.
  Merge in order from #22 using merge commits (squash breaks the stack).
- **Done since:** #17 Device Parameters on branch `issue-17-device-parameters`.
- **Remaining:** #18 Parameter Mapping & Push, #19 FFT/PSD, #20 Attitude 3D Panel,
  #21 XY/table Panels + dockable layout. Start #18 from branch `issue-17-device-parameters`.
- Last full verification on `issue-16-…`: `pnpm typecheck` clean, `pnpm test` 110 passed,
  `pnpm test:e2e` 12 passed. CI runs on every stacked PR (`pull_request` trigger); earlier red
  runs on #25, #26, #33 and #36 came from the two flaky tests fixed on `issue-16-…` (see below).
- Merging PRs from the agent is blocked by the permission classifier; the user merges.

## Workflow used per ticket

1. `git checkout -b issue-<n>-<slug>` from the previous ticket branch.
2. Protocol schemas in `packages/protocol` first, then server, then web.
3. Seam A tests (`apps/server/test`) and Seam B (`e2e/`), visual check in the browser pane.
4. Run `pnpm typecheck`, `pnpm test`, `pnpm test:e2e` and **check exit codes before committing**.
5. Commit with `Closes #<n>`, push, `gh pr create --base <previous branch>`.

## Decisions made during implementation

- ADR-0011 (new): Systems run in stages over strongly connected components; feedback loops are
  stepped per sample (Python Blocks inside them get one-sample chunks). Python Blocks always have
  direct feedthrough.
- Dialect hash = FNV-1a over `"<id> <NAME> <crcExtra> <payloadLength>\n"` per Message (see
  `docs/manual-acceptance.md`); Recordings store the verified hash and replays compare it.
- Python environment: `.venv/` (git-ignored) + committed `requirements.lock`, managed with uv.
- Measured Frequency Response: stepped sines with least-squares sine fit; continuous-only
  Systems oversampled 20×.

- Device Parameters (#17): the Framing exposes a `ParameterProtocol` on `FrameFormat`
  (`mavlink/params.ts`); the core `ParameterClient` (`device-parameters.ts`) does retries and
  enumeration. A write is acknowledged when the Device echoes the stored value; a different echo is a
  refusal; no echo after 3 × 500 ms is a `timeout` error. PARAM_* Messages are `control` Messages and
  produce no Signals. Values travel by C cast. Virtual Devices simulate a store (`virtual.parameters`).

## Notes for the next tickets

- #18: build Push on `parameters.read`/`parameters.write` (per-parameter results already come back as
  `accepted` + the acknowledged value). The bench template's Device Parameters (RATE_KP, RATE_KI,
  GYRO_LPF_HZ) mirror the Block Parameters Kp, Ki, fc, ready for Parameter Mappings.
- #19: Signals are buffered client-side in `apps/web/src/state/signal-store.ts`; FFT/PSD can run in
  the browser on those buffers or as a server Analysis.
- #21: layouts must persist in the Project (e.g. `layout.yaml`); panels currently are a fixed
  sidebar + `PlotStack` (Telemetry) and the Model Lab tab.
- The serial test needs `socat`; without it, it is silently skipped locally and only runs in CI.
  Without sudo: `apt-get download socat && dpkg-deb -x socat_*.deb <dir>` and put `<dir>/usr/bin` on `PATH`.
- socat removes its `link=` symlinks on exit: wait for the old process to exit before creating a new
  pair at the same paths, or it deletes the new links.
- Test pitfalls seen: Playwright name matching is substring by default (use `exact: true`);
  subscribe to Signals only after earlier runs finish (bus flush is 33 ms); create event waiters
  before triggering the action.
