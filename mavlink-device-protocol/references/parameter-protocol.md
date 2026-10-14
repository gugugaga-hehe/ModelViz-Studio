# Device Parameter protocol

The standard MAVLink parameter microservice, with the exact semantics the workbench relies on.
Both sides must follow this; most interoperability bugs are a reply that is missing or carries
the requested value instead of the stored one.

## Contents
1. Messages
2. Value encoding and types
3. Flows (enumerate, read, write)
4. Host algorithm (retries, ack, refusal, timeout)
5. Firmware obligations
6. Safety rule (no automatic sync)

## 1. Messages (copy verbatim from common.xml)

| Message | id | CRC_EXTRA | Fields |
|---|---|---|---|
| PARAM_REQUEST_READ | 20 | 214 | target_system, target_component, char[16] param_id, int16 param_index (−1 = by name) |
| PARAM_REQUEST_LIST | 21 | 159 | target_system, target_component |
| PARAM_VALUE | 22 | 220 | char[16] param_id, float param_value, uint8 param_type, uint16 param_count, uint16 param_index |
| PARAM_SET | 23 | 168 | target_system, target_component, char[16] param_id, float param_value, uint8 param_type |

`param_id` is not NUL-terminated when the name is exactly 16 characters; read at most 16 bytes.

## 2. Value encoding and types

`param_value` carries the value **by C cast** (`(float)v`), not byte-wise reinterpretation.
Integer Device Parameters are therefore exact up to 2^24; keep integer parameters within that.

| Type | MAV_PARAM_TYPE | Host name |
|---|---|---|
| uint8 / int8 | 1 / 2 | `uint8` / `int8` |
| uint16 / int16 | 3 / 4 | `uint16` / `int16` |
| uint32 / int32 | 5 / 6 | `uint32` / `int32` |
| float (REAL32) | 9 | `float` |

Float Device Parameters store single precision: the Device reports `fround(v)`, and the host
compares acknowledgements in single precision.

## 3. Flows

Addresses: workbench sends from sysid **255**, compid **190**, to the sysid/compid its telemetry
comes from (broadcast 0/0 before any frame has been seen).

**Enumerate**
```
host  → PARAM_REQUEST_LIST
device→ PARAM_VALUE(index 0, count N) … PARAM_VALUE(index N−1, count N)   (paced, any order)
host  → PARAM_REQUEST_READ(param_index = i)   for every i still missing after 500 ms quiet
device→ PARAM_VALUE(index i, count N)
```
**Read**: `PARAM_REQUEST_READ(param_id = name, param_index = −1)` → `PARAM_VALUE(name, …)`.

**Write**: `PARAM_SET(name, value, type)` → `PARAM_VALUE(name, stored value, …)`.
- stored == requested (in the parameter's type) → **acknowledged**
- stored != requested → **refused**; the reply shows what the Device kept
- no reply → retry; after the last attempt → **timeout**

## 4. Host algorithm

- Each exchange: send, wait 500 ms for a matching PARAM_VALUE (by name), resend, up to 3 attempts,
  then fail with a `timeout` error naming the parameter.
- Enumeration: send LIST (up to 3 times until the first reply gives `param_count`), collect by
  index until complete or 500 ms without new values, then re-request missing indices by index,
  up to 3 rounds. Report indices still missing instead of failing the whole list.
- Before a write: know the type (read it first if unknown). Reject locally, without sending,
  values that do not fit an integer type (non-integer, out of range). Names > 16 chars are
  rejected locally too.
- Every PARAM_VALUE received, solicited or not, updates the host's view and is broadcast to UIs.
- Parameter traffic is only possible on a running live or virtual Source after the dialect check
  passed; a Log Replay cannot send.

## 5. Firmware obligations

- Answer every PARAM_SET for a known name with PARAM_VALUE holding the **stored** value — also
  when the write was refused (read-only, out of range, wrong type). Never echo the request.
- Unknown names: no reply (the host times out). Do not invent an entry.
- `PARAM_REQUEST_READ` with `param_index ≥ 0` looks up by index, otherwise by name.
- `PARAM_REQUEST_LIST`: send all values with correct `param_index`/`param_count`; pace them
  through the TX queue (e.g. a few per ms) so telemetry keeps flowing; indices must be stable
  for a firmware build.
- Accept `target_system` equal to the Device's sysid or 0; ignore others.
- Apply validation (range, read-only, integer cast) **before** storing; persist to flash only if
  the product wants it, and say so in its docs.

## 6. Safety rule (ADR-0008)

Parameter writes happen only on explicit user action, one parameter at a time, or through a Push
that shows the diff of current Device values vs proposed values and waits for confirmation. No
code path may write Device Parameters from model (Block Parameter) changes automatically, and
reading never changes model values.
