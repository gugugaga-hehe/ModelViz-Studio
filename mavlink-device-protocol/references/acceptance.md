# Bring-up, debugging and acceptance

## Symptom → likely cause

| What the host shows | Likely cause | Check |
|---|---|---|
| "Dialect hash mismatch" | Firmware built from a different XML, or hash typed by hand | `dialect_hash.py <xml>` on both trees; regenerate `dialect_hash.h` |
| "No dialect hash received" | DIALECT_INFO not sent, not sent after connect, or frames rejected | Is DIALECT_INFO in the dialect and Frame Format `dialectCheck`? MAVLink2? unsigned? |
| Stuck in "verifying", discarded bytes rising | Not MAVLink2 (0xFE frames), wrong baud | Logic analyser / hex dump; `MAVLINK_STATUS_FLAG_OUT_MAVLINK1` |
| CRC errors rising | Dialect differs for some Messages; partial frames on TX overflow; electrical noise | Compare CRC_EXTRAs (`--table`); enqueue whole frames only |
| Unknown Messages rising | Device sends Messages missing from the host's dialect | Add them to the XML, or stop sending them |
| Sequence gaps | Real loss (TX overflow, USB stalls) or per-Message seq counters | `tx_overflows` counter; single channel for all frames |
| Missed frames / rate deviation | Frame rate ≠ `nominalRateHz`, or loss | Measure on the Device; fix the declaration or the scheduler |
| Timing jumps | Timestamps taken at send time, 32-bit timer wrap, reboot | `micros64()` at sample time |
| Parameter write "Refused" unexpectedly | Range/read-only/integer validation on the Device | Device's table; value representable in type? |
| Parameter "No answer … after 3 attempts" | Name unknown, target_system filter, RX path not fed | Is `on_rx_byte` called? Accept sysid 0? |
| Enumeration reports missing indices | LIST burst overflowed TX buffer | Pace the list (`param_list_task`) |

## Manual acceptance on hardware

Firmware prerequisites: MAVLink2 with the Project's dialect, signing disabled; DIALECT_INFO.hash
after connecting and periodically; high-rate data batched with Device Timestamps; standard
PARAM_* with C-cast values, every PARAM_SET answered with the stored value.

Link
- [ ] The board appears in the serial port list (USB ports first).
- [ ] Connect: `connecting → verifying dialect → running`.
- [ ] Firmware built from an older XML is rejected with "Dialect hash mismatch"; no telemetry shown.
- [ ] Unplug: "link lost — reconnecting"; replug: reconnects and re-verifies without restarting anything.
- [ ] Sustained 4–8 kHz telemetry for several minutes: no CRC errors, no sequence gaps, no missed frames.

Device Parameters
- [ ] "Read all from Device" lists every Device Parameter with no missing indices.
- [ ] Writing a value shows "Acknowledged by the Device"; reading back (or after reboot, if persisted) shows it.
- [ ] Writing a refused value shows "Refused" with the value the Device kept.

Recording
- [ ] A Recording at full rate replays with original timing and shows the same Signals; after
      fixing a Frame Format, re-decoding the Recording shows the corrected Fields.
