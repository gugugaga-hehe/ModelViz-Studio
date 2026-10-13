# MAVLink2 with a custom dialect is the first Device protocol

The first target (STM32F407VET6 over USB full-speed CDC) speaks MAVLink2 with a project-specific dialect, instead of a fully custom protocol. MAVLink2 supplies the control plane the workbench needs (Device Parameters, Commands with acknowledgement, heartbeat, time sync, multi-Device addressing, sequence numbers for drop detection), which a custom protocol would have to reinvent, and it keeps the door open to mainstream firmware. High-rate telemetry uses dialect Messages that batch several samples per frame with a Device Timestamp, which keeps framing overhead within roughly 10% of a minimal custom frame.

## Consequences

- Standard MAVLink telemetry Messages are not used for high-rate data; they are designed for much lower rates.
- Message signing is disabled on direct USB links.
- Because mismatched dialects make MAVLink silently drop frames, the workbench and Device compare a dialect hash on connect and refuse to proceed on mismatch.
- Changing the dialect means regenerating code on both sides.
