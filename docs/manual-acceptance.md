# Manual acceptance checklist

Automated tests cover everything through Seam A and Seam B with Virtual Devices, TCP, UDP and pseudo-terminal serial ports. These checks need real hardware (first target: STM32F407VET6, USB OTG full-speed CDC) and are run by hand before a release.

## Firmware prerequisites

- Speaks MAVLink2 with the Project's dialect, message signing disabled (ADR-0009).
- Sends `DIALECT_INFO.hash` (or the Message/Field named by the Frame Format's `dialectCheck`) shortly after connecting, and periodically.
  - The hash is FNV-1a 32-bit over one line per Message, sorted by id: `"<id> <NAME> <crcExtra> <payloadLength>\n"`, sent as an unsigned 32-bit integer. The UI shows the expected value next to each Device.
- High-rate telemetry uses batched Messages with a Device Timestamp (ADR-0009, ADR-0006).

## Serial over USB CDC

- [ ] The board appears in the serial port list (USB ports listed before legacy `ttyS*` ports).
- [ ] Connect at the configured baud rate: state goes `connecting → verifying dialect → running`.
- [ ] A wrong dialect (e.g. firmware built from an older XML) is rejected with a "Dialect hash mismatch" message and no telemetry is shown.
- [ ] Unplug the cable: state shows "link lost — reconnecting". Replug: it reconnects and re-verifies without restarting anything.
- [ ] Sustained 4–8 kHz telemetry: link health shows no CRC errors and no sequence gaps over several minutes.
