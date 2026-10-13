# Blocks process chunks of samples, and live Systems lag by one chunk

Every Block, declarative or Python, is executed on chunks of samples rather than one sample at a time, and a System driven by a live Signal runs once per chunk (on the order of 50–100 ms). Per-sample calls into Python cannot keep up with 4–8 kHz telemetry; accepting one chunk of latency on live model output keeps the same Block code usable for live data, Recordings and offline Analysis.
