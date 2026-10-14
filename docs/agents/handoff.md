# Handoff: MVP implementation progress

Spec: gugugaga-hehe/ModelViz-Studio#1 (tickets #2–#21, all `ready-for-agent`).

## State (2026-10-14)

- **MVP complete and merged.** All 20 tickets (#2–#21) landed on `main` via PRs #22–#41 (merge
  commits, in stack order); every ticket issue is closed and CI on `main` is green.
- The stacked-branch workflow is over: ticket branches are deleted, new work branches from `main`
  and opens PRs against `main`.
- Last verification before merge (on the final ticket branch): `pnpm typecheck` clean, `pnpm test`
  134 passed, e2e 17 passed.
- Merging PRs from the agent is blocked by the permission classifier; the user merges.

### Open follow-ups (not tickets yet)

- One CI run (#33) once timed out waiting for serial state `lost`; not reproduced. `waitForSource`
  now prints the states it saw, so a recurrence will say where it stuck.
- Measured Frequency Response is slow (~15 s for the example loop with the loop broken): feedback
  loops are stepped per sample (ADR-0011) and continuous-only Systems run 20× oversampled.
- Header nav overflows on narrow windows (pre-existing).

## Setting up a new environment

1. `git fetch && git checkout main`, then `pnpm install`.
2. `pnpm exec playwright install chromium` for `pnpm test:e2e` (CI installs it itself).
3. `socat` for the serial pty test (otherwise silently skipped locally): `sudo apt install socat`,
   or without sudo `apt-get download socat && dpkg-deb -x socat_*.deb ~/opt/socat` and put
   `~/opt/socat/usr/bin` on `PATH`.
4. `uv` for the Python environment tests (CI uses `astral-sh/setup-uv`).
5. App preview: `pnpm build && pnpm start` (port 5174); `.claude/launch.json` defines it for the
   Claude desktop browser pane.
6. The `mavlink-device-protocol` skill (root folder, linked from `.claude/skills/`) holds the
   MAVLink2 dialect / firmware / host standard and `scripts/dialect_hash.py`.

## Workflow per ticket

1. `git checkout -b issue-<n>-<slug>` from `main`.
2. Protocol schemas in `packages/protocol` first, then server, then web.
3. Seam A tests (`apps/server/test`) and Seam B (`e2e/`), visual check in the browser pane.
4. Run `pnpm typecheck`, `pnpm test`, `pnpm test:e2e` and **check exit codes before committing**.
5. Commit with `Closes #<n>`, push, `gh pr create --base main`.

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

- Parameter Mappings (#18) live in `project.yaml` (`parameterMappings`) and point at a Block
  Parameter of a System Block; its value is the System override, else the Block default. Push is
  `push.preview` (reads only) then `push.apply` (writes exactly the previewed changes, once; refused
  if a Block Parameter changed since). `push.ts` is the only code that writes Block Parameter values
  to a Device. The MAVLink protocol standard is captured in the `mavlink-device-protocol` skill.

- Panel layout (#21): the Telemetry view's Panels live in dockview (`dockview-react`, pinned). Its
  `toJSON()` (including each Panel's params, e.g. selected Signals) is saved as `layout.yaml` via
  `layout.get`/`layout.set`; the server stores it opaquely. Panels subscribe through
  `retainSignals()` (ref-counted: the server keeps one subscription per Signal per connection).
  A new Panel kind = a component in `Workspace.tsx`'s `components` map + `TITLE_KEY` + toolbar button.

- FFT/PSD (#19) is the server Analysis `analysis.spectrum` (`model/spectrum.ts`): the Panel sends the
  newest N samples (times + values) of any Signal; the server resamples onto a uniform grid at the
  median interval, windows (Hann, Hamming, Blackman, flat top, rectangular), and returns a one-sided
  amplitude spectrum (sine of amplitude A → peak A) and PSD (integrates to the variance). Numerical
  checks live in Seam A, so DSP stays on the server.

- Attitude 3D Panel (#20): Three.js (pinned `0.186.1`) spherical reference frame with horizon ring,
  reference axes, and vehicle body model with OrbitControls. Input accepts quaternion (w, x, y, z) or
  Euler (roll, pitch, yaw) Signal sets picked per Panel and saved in its params. Quaternions are
  normalised via `Math.hypot`. Renders at display rate from the newest sample
  (`signalStore.buffer(h).latestValue()`), never per sample. Exposes applied rotation and atomic
  quaternion on data attributes for fast, deterministic Seam B smoke testing. Dialect Message
  `BENCH_ATTITUDE` added to `bench.xml`, `bench.yaml`, and virtual bench template.

## Notes for future iterations

- The serial test needs `socat`; without it, it is silently skipped locally and only runs in CI.
  Without sudo: `apt-get download socat && dpkg-deb -x socat_*.deb <dir>` and put `<dir>/usr/bin` on `PATH`.
- socat removes its `link=` symlinks on exit: wait for the old process to exit before creating a new
  pair at the same paths, or it deletes the new links.
- Test pitfalls seen: Playwright name matching is substring by default (use `exact: true`);
  subscribe to Signals only after earlier runs finish (bus flush is 33 ms); create event waiters
  before triggering the action.
