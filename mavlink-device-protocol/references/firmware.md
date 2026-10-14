# Firmware implementation

Reference implementation pattern for an MCU Device (first target: STM32F407VET6, USB OTG
full-speed CDC). The code is C against the standard **mavgen**-generated MAVLink library; adapt
the HAL calls to your platform. Function names for custom Messages follow mavgen's scheme
(`mavlink_msg_<message_lower>_pack_chan`); check the generated headers for argument order.

## Contents
1. Code generation
2. Node setup (MAVLink2, unsigned, addresses)
3. TX path that sustains ~1 MB/s
4. Device Timestamps
5. Batched telemetry
6. Dialect handshake
7. RX path and Device Parameters
8. Common mistakes

## 1. Code generation

Generate both artefacts from the **same** XML in the build, never by hand:

```sh
python -m pymavlink.tools.mavgen --lang=C --wire-protocol=2.0 \
    --output=build/mavlink dialects/bench.xml          # -> build/mavlink/bench/mavlink.h
python mavlink-device-protocol/scripts/dialect_hash.py dialects/bench.xml \
    --c-header build/mavlink/dialect_hash.h            # -> #define DIALECT_HASH 0x....u
```

Make the firmware build depend on the XML so an edited dialect always regenerates both.

## 2. Node setup

```c
#include "bench/mavlink.h"
#include "dialect_hash.h"

#define DEV_SYSID  1
#define DEV_COMPID 1
#define CHAN       MAVLINK_COMM_0

void link_init(void) {
    mavlink_status_t *st = mavlink_get_channel_status(CHAN);
    st->flags &= ~MAVLINK_STATUS_FLAG_OUT_MAVLINK1;   /* always send MAVLink2 */
    /* no signing: never call mavlink signing setup on direct links */
}
```

The generated library keeps one sequence counter per channel and increments it for every
packed frame. Pack every frame with the `_chan` variants on the same channel, and do not drop a
frame after packing it without accepting the resulting sequence gap — the host counts gaps as
lost frames, which is exactly what you want it to see.

## 3. TX path that sustains ~1 MB/s

USB FS CDC reaches ~1 MB/s only with large transfers. Pack frames into a TX ring buffer and let
one place drain it in big chunks.

```c
static uint8_t  tx_ring[16384];          /* power of two */
static volatile uint32_t tx_head, tx_tail;

/* Enqueue a whole frame or nothing: a half-written frame would desync the receiver. */
static bool tx_frame(const mavlink_message_t *msg) {
    uint8_t buf[MAVLINK_MAX_PACKET_LEN];
    uint16_t n = mavlink_msg_to_send_buffer(buf, msg);
    uint32_t used = tx_head - tx_tail;
    if (sizeof tx_ring - used < n) { tx_overflows++; return false; }   /* frame lost: seq gap */
    for (uint16_t i = 0; i < n; i++) tx_ring[(tx_head + i) & (sizeof tx_ring - 1)] = buf[i];
    tx_head += n;
    return true;
}

/* Main loop / USB TX-complete callback: send the largest contiguous chunk available. */
void tx_pump(void) {
    if (usb_cdc_busy()) return;
    uint32_t used = tx_head - tx_tail;
    if (!used) return;
    uint32_t start = tx_tail & (sizeof tx_ring - 1);
    uint32_t n = MIN(used, sizeof tx_ring - start);
    n = MIN(n, 4096);
    if (usb_cdc_transmit(&tx_ring[start], n) == OK) tx_tail += n;   /* advance on accept */
}
```

- Producers (control loop, sensor tasks) only pack + enqueue; never block on USB.
- Size the ring for the longest host stall you want to ride through (16 KB ≈ 16 ms at 1 MB/s).
- When a single producer runs in an ISR and the pump in thread context, the head/tail scheme
  above is lock-free; with several producers, enqueue from one context or add a critical section.

## 4. Device Timestamps

```c
/* Monotonic microseconds since boot, 64-bit (a 32-bit 1 MHz timer wraps every ~71 min). */
uint64_t micros64(void) {
    static uint32_t last; static uint64_t high;
    uint32_t now = TIM2->CNT;                 /* free-running 32-bit timer at 1 MHz */
    if (now < last) high += 1ull << 32;
    last = now;
    return high | now;
}
```

Call it from one context (or protect it). Take the timestamp **when the sample is taken**, not
when the frame is sent. The host anchors Device time to host time once and keeps Device
intervals exact; time going backwards by > 1 s is treated as a reboot.

## 5. Batched telemetry

```c
#define BATCH 8
static float gx[2][BATCH], gy[2][BATCH], gz[2][BATCH];
static uint64_t t0[2];
static uint8_t fill, k;          /* buffer being filled, sample index */
static volatile int8_t ready = -1;

void imu_sample_isr(float x, float y, float z) {   /* runs at exactly 1 kHz */
    if (k == 0) t0[fill] = micros64();               /* time of element 0 */
    gx[fill][k] = x; gy[fill][k] = y; gz[fill][k] = z;
    if (++k == BATCH) { ready = fill; fill ^= 1; k = 0; }
}

void telemetry_task(void) {
    if (ready < 0) return;
    int8_t b = ready; ready = -1;
    mavlink_message_t msg;
    mavlink_msg_bench_imu_batch_pack_chan(DEV_SYSID, DEV_COMPID, CHAN, &msg,
                                          t0[b], gx[b], gy[b], gz[b]);
    tx_frame(&msg);
}
```

Samples inside a frame must be equally spaced at the rate declared in the Frame Format
(`sampleRateHz`), or the Message must carry an interval Field. Keep frame rates constant and
equal to the declared `nominalRateHz`; the host uses them to count missed frames.

## 6. Dialect handshake

```c
void dialect_info_1hz(void) {             /* also call once right after the host connects */
    mavlink_message_t msg;
    mavlink_msg_dialect_info_pack_chan(DEV_SYSID, DEV_COMPID, CHAN, &msg, DIALECT_HASH);
    tx_frame(&msg);
}
```

The host discards everything until a matching hash arrives and gives up after 5 s, so send it
within 1 s of a connection (for USB CDC, when the host asserts DTR / opens the port) and keep
sending it at 1 Hz — the host re-verifies after every reconnect.

## 7. RX path and Device Parameters

```c
typedef struct { const char *name; uint8_t type; float *f; int32_t *i; float min, max; bool ro; } param_t;
extern float rate_kp, rate_ki, gyro_lpf_hz; extern int32_t ctrl_mode, fw_version;
static const param_t params[] = {          /* index = position: stable per build */
    { "RATE_KP",     MAV_PARAM_TYPE_REAL32, &rate_kp,     0, 0, 5   },
    { "RATE_KI",     MAV_PARAM_TYPE_REAL32, &rate_ki,     0, 0, 200 },
    { "GYRO_LPF_HZ", MAV_PARAM_TYPE_REAL32, &gyro_lpf_hz, 0, 5, 500 },
    { "CTRL_MODE",   MAV_PARAM_TYPE_UINT8,  0, &ctrl_mode, 0, 3   },
    { "FW_VERSION",  MAV_PARAM_TYPE_INT32,  0, &fw_version, 0, 0, true },
};
#define NPARAMS (sizeof params / sizeof params[0])

static float get(const param_t *p) { return p->f ? *p->f : (float)*p->i; }   /* C cast */

static void send_value(uint16_t i) {
    char id[16] = {0};
    strncpy(id, params[i].name, 16);
    mavlink_message_t msg;
    mavlink_msg_param_value_pack_chan(DEV_SYSID, DEV_COMPID, CHAN, &msg,
                                      id, get(&params[i]), params[i].type, NPARAMS, i);
    tx_frame(&msg);
}

static int find(const char id[16]) {
    for (unsigned i = 0; i < NPARAMS; i++) if (strncmp(id, params[i].name, 16) == 0) return i;
    return -1;
}

static bool for_us(uint8_t sys) { return sys == DEV_SYSID || sys == 0; }
static int list_next = -1;                 /* next index to send for PARAM_REQUEST_LIST */

void on_rx_byte(uint8_t c) {               /* feed every received byte */
    static mavlink_message_t msg; static mavlink_status_t st;
    if (!mavlink_parse_char(CHAN, c, &msg, &st)) return;
    switch (msg.msgid) {
    case MAVLINK_MSG_ID_PARAM_REQUEST_LIST: {
        mavlink_param_request_list_t r; mavlink_msg_param_request_list_decode(&msg, &r);
        if (for_us(r.target_system)) list_next = 0;   /* paced by param_list_task() */
        break; }
    case MAVLINK_MSG_ID_PARAM_REQUEST_READ: {
        mavlink_param_request_read_t r; mavlink_msg_param_request_read_decode(&msg, &r);
        if (!for_us(r.target_system)) break;
        int i = r.param_index >= 0 ? r.param_index : find(r.param_id);
        if (i >= 0 && i < (int)NPARAMS) send_value(i);   /* unknown: no reply */
        break; }
    case MAVLINK_MSG_ID_PARAM_SET: {
        mavlink_param_set_t r; mavlink_msg_param_set_decode(&msg, &r);
        if (!for_us(r.target_system)) break;
        int i = find(r.param_id);
        if (i < 0) break;                                  /* unknown: no reply */
        const param_t *p = &params[i];
        float v = r.param_value;
        if (!p->ro && v >= p->min && v <= p->max) {
            if (p->f) *p->f = v; else *p->i = (int32_t)v;  /* C cast, truncation */
        }
        send_value(i);                                     /* always the stored value */
        break; }
    }
}

void param_list_task(void) {                /* a few per call, so telemetry keeps flowing */
    for (int n = 0; n < 4 && list_next >= 0; n++) {
        send_value(list_next);
        if (++list_next == (int)NPARAMS) list_next = -1;
    }
}
```

Apply new values at a safe point of the control loop (e.g. copy into the loop's working set at
the start of a cycle), so a write never takes effect mid-computation.

## 8. Common mistakes

| Mistake | Effect on the host |
|---|---|
| Hash typed by hand / stale header | "Dialect hash mismatch", no telemetry |
| MAVLink1 frames (0xFE) | ignored; looks like a dead link |
| Signing enabled | frames not accepted |
| Timestamp taken at send time | jitter in Signals, false timing jumps |
| Frame rate differs from `nominalRateHz` | rate deviation / missed-frame warnings |
| Separate seq counters per Message | spurious sequence gaps |
| Partial frames written when the TX buffer is full | CRC errors and resync bytes |
| PARAM_SET echoes the requested value | refusals reported as acknowledged |
| PARAM_LIST sent in one burst into a small buffer | missing indices (host re-requests them, slowly) |
