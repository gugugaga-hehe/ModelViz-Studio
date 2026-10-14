# Dialect design

How to write the product's MAVLink dialect XML so that firmware, workbench and Recordings
agree. Start from `../assets/dialect-template.xml`.

## Contents
1. What a dialect contains
2. Field types and wire order
3. CRC_EXTRA and the dialect hash — what changes them
4. Designing high-rate (batched) Messages
5. Bandwidth budget
6. Naming, ids and units
7. Change checklist

## 1. What a dialect contains

| Message | id | Purpose | Required |
|---|---|---|---|
| `HEARTBEAT` | 0 | Presence; standard definition copied verbatim | recommended |
| `PARAM_REQUEST_READ`, `PARAM_REQUEST_LIST`, `PARAM_VALUE`, `PARAM_SET` | 20–23 | Device Parameters; standard definitions copied verbatim | if the Device has parameters |
| `DIALECT_INFO { uint32_t hash }` | private range | Dialect handshake | yes |
| State Messages (`<PRODUCT>_STATE`) | private range | Low/medium-rate scalars, one sample per frame | as needed |
| Batched Messages (`<PRODUCT>_<SENSOR>_BATCH`) | private range | High-rate samples, N per frame | for > ~500 Hz data |

Copy standard Messages from `common.xml` **exactly** (same field names, types, order). Their
CRC_EXTRA must come out as the standard value, otherwise standard tools cannot talk to the
Device: HEARTBEAT 50, PARAM_REQUEST_READ 214, PARAM_REQUEST_LIST 159, PARAM_VALUE 220,
PARAM_SET 168. `scripts/dialect_hash.py --table` prints them.

Prefer copying over `<include>common.xml`: an include pulls hundreds of Messages into the hash,
so an unrelated upstream `common.xml` update would change the hash and lock out deployed
firmware.

## 2. Field types and wire order

Types: `uint8_t int8_t uint16_t int16_t uint32_t int32_t uint64_t int64_t float double char`,
arrays as `float[8]`, and `uint8_t_mavlink_version` (treated as `uint8_t`).

MAVLink2 does **not** send fields in XML order. Wire order = base fields sorted by element size,
largest first (stable for equal sizes), then extension fields in XML order. Array element size
is the scalar size (a `float[8]` sorts with 4-byte fields). Payload length is the sum of all
fields; at most 255 bytes.

MAVLink2 truncates trailing zero bytes of the payload on the wire; receivers zero-pad back to
the full length. This is automatic; it just means frame size varies.

How fields become Signals on the host:
- numeric scalar → one Signal `<device>/<MESSAGE>.<field>`
- numeric array not declared as batch → one Signal per element, `<field>[i]`
- numeric array declared as batch → one Signal with N samples per frame
- `char[n]` → text, not a Signal
- Messages belonging to the parameter protocol → no Signals (control plane)

## 3. CRC_EXTRA and the dialect hash — what changes them

CRC_EXTRA (per Message, seeds the frame CRC) is computed from `"<NAME> "` and, for each base
field in wire order, `"<type> <name> "` plus the array length byte. The dialect hash is
FNV-1a 32-bit (offset 0x811c9dc5, prime 0x01000193) over `"<id> <NAME> <crcExtra> <payloadLength>\n"`
for every Message sorted by id, sent as `uint32` and displayed as 8 lowercase hex digits.

| Edit | CRC_EXTRA | Hash |
|---|---|---|
| Add / remove / rename a Message, change its id | — | changes |
| Rename a field, change type or array length | changes | changes |
| Reorder base fields of the same size | changes | changes |
| Add an `<extensions/>` field | unchanged | **changes** (payload length) |
| Edit descriptions, `units`, enums | unchanged | unchanged |

So extension fields are **not** a backwards-compatible escape hatch here: any wire-visible change
means firmware and workbench must be rebuilt from the same XML. That is the point — a stale
dialect is refused loudly instead of silently dropping frames. (`units` do not affect the hash
but do change Signal units, so keep them in sync anyway.)

## 4. Designing high-rate (batched) Messages

```xml
<message id="42001" name="BENCH_IMU_BATCH">
  <field type="uint64_t" name="time_us" units="us">Device time of sample 0.</field>
  <field type="float[8]" name="gyro_x" units="rad/s">Gyro X samples.</field>
  <field type="float[8]" name="gyro_y" units="rad/s">Gyro Y samples.</field>
  <field type="float[8]" name="gyro_z" units="rad/s">Gyro Z samples.</field>
</message>
```

- One `uint64_t time_us` Device Timestamp: monotonic microseconds since boot, time of element 0.
- All batched arrays have the **same length N**; element i is at `time_us + i / sampleRate`.
- The sample spacing is either fixed (declared in the Frame Format as `sampleRateHz`) or carried
  in a Field (`intervalField`, e.g. `uint16_t interval_us`) when the Device's rate can vary.
- Non-batched scalars (status flags, counters) may sit alongside; they apply to the whole frame.
- Group Fields sampled together at the same rate into one Message. Different rates → different
  Messages.
- Choose N so the payload is ≥ ~100 bytes (overhead ≤ ~10 %) and the frame rate stays ≤ ~1–2 kHz;
  the latency added is N sample periods (8 samples at 1 kHz = 8 ms), which is fine for plotting
  and for the one-chunk latency of live model comparison.

## 5. Bandwidth budget

Frame bytes = 12 (10 header + 2 CRC) + payload. For a batched Message with F float Fields,
N samples and a `uint64` timestamp:

```
bytes/s = (sampleRate / N) × (12 + 8 + 4·F·N)
```

Example: 8 kHz × 12 floats. Unbatched (N=1): 8000 × (12+8+48) = 544 kB/s. N=5 (payload 248 B):
1600 × (12+8+240) = 416 kB/s. The whole Device should stay under ~1 MB/s (USB full-speed CDC,
ADR-0006); leave headroom for state Messages, parameter traffic and bursts.

## 6. Naming, ids and units

- Message names `UPPER_SNAKE`, prefixed with the product (`BENCH_STATE`); field names
  `lower_snake`. They appear verbatim in Signal names, so make them readable.
- Custom ids in a private range (this project uses 42000–42999). Never reuse an id for a
  different Message — loaders reject a dialect that defines one id twice.
- Put `units` on every physical Field (`rad/s`, `m/s^2`, `us`, `degC`); the UI shows them.
- Device Parameter names (not part of the XML): ≤ 16 ASCII chars, `UPPER_SNAKE`, grouped by
  prefix (`RATE_KP`, `RATE_KI`, `GYRO_LPF_HZ`).

## 7. Change checklist

1. Edit the XML; run `python scripts/dialect_hash.py <xml> --table` and review wire order,
   lengths and the standard CRC_EXTRAs.
2. Regenerate firmware code (mavgen) and the hash header (`--c-header`); rebuild firmware.
3. Update the Frame Format (new Messages: `deviceTimestamp`, `nominalRateHz`, `batch`).
4. Check the bandwidth budget.
5. Commit XML, Frame Format and generated header together; old Recordings still replay (their
   verified hash is stored with them) but will be decoded with the new definitions.
