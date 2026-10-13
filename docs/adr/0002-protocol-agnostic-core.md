# Protocol-agnostic core with Frame Formats

The core has no built-in knowledge of any firmware's protocol: every Device is described by a Frame Format (a Framing plus its Messages), and the rest of the system only sees Messages, Fields and Signals. The first Framing is MAVLink2 (see ADR-0009), but products that cannot run MAVLink must still be supportable with a custom Framing, and mainstream firmware support must be layered on as Frame Formats or extensions, never baked into the core.
