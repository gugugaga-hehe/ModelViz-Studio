# Manual acceptance checklist

Automated tests cover everything through Seam A and Seam B with Virtual Devices, TCP, UDP and pseudo-terminal serial ports. These checks need real hardware (first target: STM32F407VET6, USB OTG full-speed CDC) and are run by hand before a release.

## Firmware prerequisites

- Speaks MAVLink2 with the Project's dialect, message signing disabled (ADR-0009).
- Sends `DIALECT_INFO.hash` (or the Message/Field named by the Frame Format's `dialectCheck`) shortly after connecting, and periodically.
  - The hash is FNV-1a 32-bit over one line per Message, sorted by id: `"<id> <NAME> <crcExtra> <payloadLength>\n"`, sent as an unsigned 32-bit integer. The UI shows the expected value next to each Device.
- High-rate telemetry uses batched Messages with a Device Timestamp (ADR-0009, ADR-0006).
- Device Parameters use the standard MAVLink parameter protocol: the dialect includes `PARAM_REQUEST_READ`, `PARAM_REQUEST_LIST`, `PARAM_VALUE` and `PARAM_SET` exactly as in `common.xml` (the bench template does).
  - `param_value` carries the value by C cast (`(float)value`), not byte-wise; integer Device Parameters are exact up to 2^24.
  - The workbench sends from system 255, component 190, to the system/component its telemetry comes from.
  - Every `PARAM_SET` is answered with a `PARAM_VALUE` holding the value actually stored; a refused write reports the old value.

## Serial over USB CDC

- [ ] The board appears in the serial port list (USB ports listed before legacy `ttyS*` ports).
- [ ] Connect at the configured baud rate: state goes `connecting → verifying dialect → running`.
- [ ] A wrong dialect (e.g. firmware built from an older XML) is rejected with a "Dialect hash mismatch" message and no telemetry is shown.
- [ ] Unplug the cable: state shows "link lost — reconnecting". Replug: it reconnects and re-verifies without restarting anything.
- [ ] Sustained 4–8 kHz telemetry: link health shows no CRC errors and no sequence gaps over several minutes.

## Device Parameters

- [ ] With the board running, "Read all from Device" in the Device Parameters view lists every Device Parameter the firmware exposes, with no missing indices.
- [ ] Writing a Device Parameter shows "Acknowledged by the Device"; reading it back (or rebooting, if the firmware persists parameters) shows the new value.
- [ ] Writing a value the firmware refuses shows "Refused" with the value the Device kept.
