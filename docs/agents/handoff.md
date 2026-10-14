# Handoff: MVP implementation progress

Spec: gugugaga-hehe/ModelViz-Studio#1 (tickets #2–#21, all `ready-for-agent`).

## State (2026-10-14)

- **Done: 19 of 20 tickets**, one stacked PR each, **none merged yet**. CI is green on every PR
  except #25, #26 and #33 (old flaky runs, see "Open follow-ups").

  | Ticket | Branch | PR | Ticket | Branch | PR |
  |---|---|---|---|---|---|
  | #2 | `issue-2-walking-skeleton` | #22 (base `main`) | #12 | `issue-12-parameter-sweeps` | #32 |
  | #3 | `issue-3-virtual-device-live-plot` | #23 | #13 | `issue-13-python-environment` | #33 |
  | #4 | `issue-4-timestamps-batching-health` | #24 | #14 | `issue-14-python-blocks` | #34 |
  | #5 | `issue-5-transports-dialect-hash` | #25 | #15 | `issue-15-measured-frequency-response` | #35 |
  | #6 | `issue-6-throughput-plot-interaction` | #26 | #16 | `issue-16-drive-systems-with-signals` | #36 |
  | #7 | `issue-7-recording-replay` | #27 | #17 | `issue-17-device-parameters` | #37 |
  | #8 | `issue-8-csv-import` | #28 | #18 | `issue-18-parameter-mapping-push` | #38 |
  | #9 | `issue-9-blocks-systems-time-analyses` | #29 | #21 | `issue-21-panels-dockable-layout` | #39 |
  | #10 | `issue-10-discretization` | #30 | #19 | `issue-19-fft-psd` | #40 |
  | #11 | `issue-11-frequency-polezero-metrics` | #31 | | | |

  Each PR targets the previous ticket's branch (#21 was done before #19). Merge in order from #22
  with **merge commits** (squash breaks the stack); GitHub retargets the next PR to `main` when the
  merged branch is deleted, and `Closes #n` only closes issues once a PR lands on `main`.
- **Latest branch:** `issue-19-fft-psd` contains everything. Last verification there:
  `pnpm typecheck` clean, `pnpm test` 134 passed, CI e2e 16 passed.
- **Remaining:** #20 Attitude 3D Panel (last MVP ticket) — see "Notes for the next tickets".
- Merging PRs from the agent is blocked by the permission classifier; the user merges.

### Open follow-ups (not tickets yet)

- PRs #25, #26, #33 still show red CI from before the flaky-test fixes on `issue-16-…`
  (serial pty replug race, slow measured loop-margin test). Re-run failed jobs, or merge the stack.
- One CI run (#33) once timed out waiting for serial state `lost`; not reproduced. `waitForSource`
  now prints the states it saw, so a recurrence will say where it stuck.
- Measured Frequency Response is slow (~15 s for the example loop with the loop broken): feedback
  loops are stepped per sample (ADR-0011) and continuous-only Systems run 20× oversampled.
- Header nav overflows on narrow windows (pre-existing).

## Setting up a new environment

1. `git fetch && git checkout issue-19-fft-psd` (or the next ticket's branch), then `pnpm install`.
2. `pnpm exec playwright install chromium` for `pnpm test:e2e` (CI installs it itself).
3. `socat` for the serial pty test (otherwise silently skipped locally): `sudo apt install socat`,
   or without sudo `apt-get download socat && dpkg-deb -x socat_*.deb ~/opt/socat` and put
   `~/opt/socat/usr/bin` on `PATH`.
4. `uv` for the Python environment tests (CI uses `astral-sh/setup-uv`).
5. App preview: `pnpm build && pnpm start` (port 5174); `.claude/launch.json` defines it for the
   Claude desktop browser pane.
6. The `mavlink-device-protocol` skill (root folder, linked from `.claude/skills/`) holds the
   MAVLink2 dialect / firmware / host standard and `scripts/dialect_hash.py`.

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

## Notes for the next tickets

- #20 Attitude 3D Panel: add a Panel kind in `Workspace.tsx` (see the #21 note above). Spec says a
  WebGL 3D library (e.g. three.js; pin the version) and a spherical reference frame; input is a
  quaternion (w, x, y, z) or Euler (roll, pitch, yaw) Signal set picked per Panel and saved in its
  params. Normalise quaternions before use. The bench template has no attitude Signals yet: add a
  dialect Message (e.g. `BENCH_ATTITUDE` with `q[4]` or roll/pitch/yaw) plus Virtual Device
  generators, or test with a CSV Log Replay. Render at display rate from the newest sample
  (`signalStore.buffer(h).latestValue()`), never per sample. Seam B smoke: known orientations render
  (expose the applied rotation as data attributes rather than comparing pixels).

- The serial test needs `socat`; without it, it is silently skipped locally and only runs in CI.
  Without sudo: `apt-get download socat && dpkg-deb -x socat_*.deb <dir>` and put `<dir>/usr/bin` on `PATH`.
- socat removes its `link=` symlinks on exit: wait for the old process to exit before creating a new
  pair at the same paths, or it deletes the new links.
- Test pitfalls seen: Playwright name matching is substring by default (use `exact: true`);
  subscribe to Signals only after earlier runs finish (bus flush is 33 ms); create event waiters
  before triggering the action.
