# Host side (workbench, decoders, ground tools)

How the ModelViz Studio server is built around the protocol, so a new host app — or a new
feature in the workbench — follows the same layering and algorithms. Paths refer to this repo.

## Contents
1. Layering
2. Frame Format file
3. Framing: parsing and link counters
4. DeviceLink: dialect gate, timestamps, batching, health
5. Transports and reconnection
6. Sending to the Device
7. Recordings and Log Replay
8. Testing without hardware

## 1. Layering

| Layer | Knows | Repo |
|---|---|---|
| Transport | bytes; serial/TCP/UDP; reconnect | `apps/server/src/transports.ts` |
| Framing | MAVLink2 wire format, dialect, PARAM_* | `apps/server/src/mavlink/*`, `frame-format.ts` |
| DeviceLink | Messages → timestamped samples, health, dialect gate | `device-link.ts` |
| Source | connection state machine, outbound path | `active-source.ts` |
| ParameterClient | retries, enumeration, ack (framing-neutral) | `device-parameters.ts` |
| Workbench | Project, Signals, client protocol | `workbench.ts` |

Only the Framing imports MAVLink code. It exposes `FrameFormat { messages, dialectHash,
dialectCheck?, parameters?, createDecoder(), createEncoder(sender?) }`; everything above uses
that. Keep this boundary in new host code: it is what lets a non-MAVLink product be added as
another Framing (ADR-0002).

## 2. Frame Format file

A Frame Format is a YAML file in the Project that points at the dialect and adds what the XML
cannot say. Template: `../assets/frame-format-template.yaml`.

```yaml
framing: mavlink2
dialect: ../dialects/bench.xml          # relative to this file
dialectCheck: { message: DIALECT_INFO, field: hash }   # integer scalar Field
messages:
  BENCH_STATE:
    deviceTimestamp: { field: time_us, unit: us }   # us | ms | s
    nominalRateHz: 500
  BENCH_IMU_BATCH:
    deviceTimestamp: { field: time_us, unit: us }
    nominalRateHz: 125
    batch:
      fields: [gyro_x, gyro_y, gyro_z]   # numeric arrays of equal length
      sampleRateHz: 1000                 # or intervalField: { field: dt_us, unit: us }
```

Validation rules: unknown Messages/Fields are errors; a batch needs a Device Timestamp and
exactly one of `sampleRateHz`/`intervalField`; the dialect check Field must be an integer scalar.

## 3. Framing: parsing and link counters

Incremental parser over arbitrary chunks:
- Scan for STX `0xFD`; bytes skipped while searching count as *discarded bytes*.
- Need 10 header bytes; `len` = byte 1; signed frames (incompat flag 0x01) carry 13 extra bytes.
- Unknown msgid: count *unknown message*, skip **only the start byte** (without the definition the
  length cannot be trusted).
- CRC: X.25 over bytes 1..end of payload, then accumulate CRC_EXTRA; mismatch → count
  *CRC error*, skip one byte, resync.
- Payload is zero-padded to the full length before decoding (MAVLink2 truncation).
- Sequence: per (sysid, compid), `gaps += (seq − last − 1) mod 256`.
- Decoded output carries the sender address, used to target parameter requests.

## 4. DeviceLink

Per decoded Message, in order:
1. **Dialect gate.** While pending, ignore everything except the check Message; compare its Field
   (as uint32 → 8 hex digits) with the Frame Format's hash. Match → running; mismatch → reject the
   Source with "Dialect hash mismatch: Device reports X, Frame Format expects Y" and ignore all
   further data. No hash within 5 s → reject "No dialect hash received". Reconnect → pending again.
2. Hand the Message to observers (the ParameterClient).
3. **Time.** With a Device Timestamp: `t = deviceMs + offset`, offset fixed at the first frame,
   re-anchored if Device time goes back > 1 s; the Host Timestamp is kept alongside. Without one:
   Host Timestamp.
4. **Batching.** Element i of a batched Field → sample at `t + i·interval`.
5. **Health.** Frames and rate per Message over ≥ 0.5 s windows; with a nominal rate, Device
   time gaps give *missed frames* `round(gap/period) − 1` and *timing jumps* (gap ≤ 0 or > 50
   periods); a rate > 10 % off nominal is flagged. Plus the Framing counters (CRC errors,
   sequence gaps, unknown Messages, discarded bytes).

Control-plane Messages (PARAM_*) are still counted in health but produce no Signals.

## 5. Transports and reconnection

- Serial (any baud; USB adapters/CDC listed first), TCP client, UDP (bind locally; reply to the
  configured or last-seen peer).
- Stream Transports retry every 500 ms until stopped; states `connecting → verifying → running`,
  `lost` on drop, back to `verifying` on reconnect. The dialect is re-verified each time, because
  the Device may have been reflashed.

## 6. Sending to the Device

Each live or virtual Source has an outbound path (`Transport.write`). Encode with
`createEncoder({ system: 255, component: 190 })` — a separate sequence counter from the Device's.
Log Replays have no outbound path; parameter and command requests on them are refused.

## 7. Recordings and Log Replay

Record the raw inbound byte chunks with Host Timestamps plus metadata (Device, verified dialect
hash) — not decoded values. Replay re-decodes with the current Frame Format at original timing
(pause/seek/speed); the dialect check compares the Recording's stored hash with the Frame
Format instead of waiting for in-stream DIALECT_INFO (a Recording may start between reports).

## 8. Testing without hardware

- A Virtual Device emits genuine Frame Format bytes from generators, honours the same rates,
  timestamps and batching, can inject drops/corruption/jitter, auto-fills the dialect hash, and
  answers PARAM_* from a simulated store (types, ranges, read-only).
- Test through the public seam only: drive a real server with the client protocol and assert on
  Signals, results and **Device-facing bytes** (decode what the host sent with the parser);
  physical links are covered by pseudo-terminals (socat) and TCP/UDP loopback, real boards by
  `acceptance.md`.
