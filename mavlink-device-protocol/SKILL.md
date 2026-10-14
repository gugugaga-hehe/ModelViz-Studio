---
name: mavlink-device-protocol
description: Architecture and implementation standard for talking MAVLink2 between an embedded Device (e.g. STM32 over USB CDC, UART, TCP/UDP) and a host workbench, as used by ModelViz Studio. Covers custom dialect design, the dialect-hash handshake, high-rate batched telemetry with Device Timestamps, link-health accounting, the Device Parameter protocol (PARAM_*), Frame Format files, and the matching firmware and host-side code. Use this skill whenever designing or reviewing a MAVLink dialect, writing firmware that streams telemetry or exposes parameters to ModelViz Studio or a similar tool, building a host app/decoder/ground tool for such a Device, adding a Message or Device Parameter, debugging "dialect hash mismatch", dropped frames, CRC errors or parameter write timeouts — even if the user only says "telemetry protocol", "serial protocol for my board", "MAVLink", "parameters over USB" or "make the firmware talk to the workbench".
---

# MAVLink2 Device protocol (ModelViz Studio standard)

This skill captures how ModelViz Studio and its Devices talk, so that new firmware, new host
apps, and new Messages stay compatible with what is already deployed. The decisions behind it
live in the repo's ADRs (0002, 0006, 0007, 0008, 0009); this skill turns them into rules and
working patterns.

## Why MAVLink2 with a custom dialect

MAVLink2 gives a framed, CRC-checked byte stream with sequence numbers, sender addressing,
a parameter protocol and command acknowledgement — the control plane a debugging workbench
needs — without inventing one. Standard telemetry Messages are designed for tens of Hz, so
high-rate data uses **project-specific dialect Messages that batch several samples per frame**,
keeping framing overhead near 10 % of a minimal custom frame. Because a mismatched dialect makes
MAVLink silently drop frames (wrong CRC_EXTRA → CRC failure), **both sides compare a dialect
hash before any telemetry is trusted**.

## Architecture at a glance

```
Device firmware                         Host workbench (server owns all I/O)
───────────────                         ──────────────────────────────────────────────
sensors/control loop                    Transport  (serial | TCP | UDP; bytes only,
  → batch ring buffers                              reconnects, knows no protocol)
  → MAVLink2 encoder (mavgen C)               ↓ bytes (+ Host Timestamp; Recordings keep raw bytes)
  → TX ring buffer → USB CDC / UART     Framing    (MAVLink2 parser: STX 0xFD, CRC_EXTRA,
                                                    seq gaps per sysid/compid, CRC errors)
param store ← PARAM_* handler                 ↓ decoded Messages {name, values, sender}
DIALECT_INFO.hash @1 Hz                 DeviceLink (dialect check gate → batch expansion →
                                                    Device Timestamp anchoring → link health)
                                              ↓ Signals "<device>/<MESSAGE>.<field>"
                                        ParameterClient (PARAM_* via the Framing's
                                                    ParameterProtocol; retries; ack = echo)
```

Two layering rules matter more than any detail:

1. **The core is protocol-agnostic (ADR-0002).** Only the Framing knows MAVLink. Everything
   above it sees Messages, Fields, Signals and a framing-neutral `ParameterProtocol`. A host app
   built on this pattern can add a custom Framing later without touching the rest.
2. **Nothing changes on the Device by itself (ADR-0008).** Parameter reads/writes happen only
   on an explicit user action; there is no live sync between model values and Device values.

## Rules every implementation follows

| Topic | Rule |
|---|---|
| Version | MAVLink **2** only, **unsigned** (signing disabled on direct links). |
| Dialect | One XML per product. Copy the few standard Messages you need (HEARTBEAT, PARAM_*) verbatim instead of `<include>common.xml`, so the hash only covers what the product uses and does not change when upstream `common.xml` changes. Custom ids in a private range (this project: 42000–42999). |
| Handshake | Firmware sends `DIALECT_INFO { uint32 hash }` within 1 s of a connection and then at 1 Hz. Host accepts no telemetry until it matches; mismatch → connection rejected with "Dialect hash mismatch"; nothing within 5 s → rejected "No dialect hash". Re-checked after every reconnect. |
| Hash | FNV-1a 32 over `"<id> <NAME> <crcExtra> <payloadLength>\n"` per Message sorted by id. Generate it, never hand-copy: `scripts/dialect_hash.py dialect.xml --c-header dialect_hash.h`. |
| Timestamps | High-rate Messages carry a monotonic `uint64 time_us` Device Timestamp (time of sample 0). Host anchors Device time to host time once; going backwards > 1 s means the Device rebooted (re-anchor). |
| Batching | High-rate fields are arrays of N consecutive samples (`float[8]`), equally spaced at a fixed rate (Frame Format `sampleRateHz`) or an interval Field. Aim for payloads ≥ ~100 bytes; ≤ 255 bytes is the hard limit. |
| Rates | Each Message has a constant nominal rate declared in the Frame Format; the host flags missed frames and timing jumps (gap ≤ 0 or > 50 periods) from Device Timestamps. |
| Sequence | One `seq` counter per (sysid, compid), incremented for **every** frame sent, of any Message. Gaps are how the host counts lost frames, so never reuse or skip-increment it. |
| Addresses | Device: sysid 1, compid 1 by default. Workbench sends as sysid 255, compid 190 and targets the address its telemetry comes from. |
| Parameters | Standard PARAM_REQUEST_LIST/READ/VALUE/SET; value by **C cast** into `param_value`; every PARAM_SET answered with PARAM_VALUE holding the stored value (also when refused); unknown names get no answer. Names ≤ 16 chars. |
| Throughput | Budget ~1 MB/s (USB full-speed CDC), e.g. 4–8 kHz × a dozen Fields, with zero loss end-to-end. |
| Recordings | Host records raw bytes + Host Timestamps, so a wrong Frame Format can be fixed and re-decoded later (ADR-0007). |

## How to use this skill

Pick the reference for the task; each is self-contained.

- **Designing or changing a dialect / adding a Message** → `references/dialect-design.md`
  (field types and wire order, CRC_EXTRA, batching math, naming, ids, what changes the hash,
  compatibility checklist). Start from `assets/dialect-template.xml`.
- **Writing firmware** (STM32/C or any MCU) → `references/firmware.md` (mavgen setup, TX path
  for 1 MB/s, timestamps, batch buffers, DIALECT_INFO, PARAM_* handler with code).
- **Building a host app, decoder, or extending the workbench** → `references/host.md`
  (layering, Frame Format YAML, parser/health algorithms, dialect gate, reconnect, Recording).
  Start from `assets/frame-format-template.yaml`.
- **Anything about Device Parameters** (either side) → `references/parameter-protocol.md`
  (message flows, enumeration with retries, ack/refusal/timeout semantics, type rules).
- **Bring-up, debugging, or acceptance on hardware** → `references/acceptance.md`
  (symptom → cause table, manual checklist).

When producing a design or code for the user:

1. State which side(s) you are changing (firmware, dialect, host) and keep the other side in
   step — a dialect change always means regenerating code **and** the hash on both sides.
2. Run `scripts/dialect_hash.py <dialect.xml> --table` after any dialect edit and show the new
   hash and CRC_EXTRAs; check standard Messages still have their standard CRC_EXTRA
   (HEARTBEAT 50, PARAM_REQUEST_READ 214, PARAM_REQUEST_LIST 159, PARAM_VALUE 220, PARAM_SET 168).
3. Check the bandwidth of any new high-rate Message against the 1 MB/s budget (formula in
   `dialect-design.md`).
4. Keep the glossary terms (Device, Device Parameter, Device Timestamp, Host Timestamp, Frame
   Format, Framing, Message, Field, Signal, Recording, Log Replay, Push) in English, in any
   UI language.

## Files

- `scripts/dialect_hash.py` — hash, CRC_EXTRA, payload length and wire order from a dialect XML
  (follows `<include>`); `--c-header` emits `DIALECT_HASH` for firmware builds; `--json` for tools.
  Verified to match the workbench's TypeScript implementation.
- `assets/dialect-template.xml` — starter dialect with HEARTBEAT, PARAM_*, DIALECT_INFO, one
  state Message and one batched Message.
- `assets/frame-format-template.yaml` — matching Frame Format with dialect check, Device
  Timestamps, nominal rates and a batch declaration.
