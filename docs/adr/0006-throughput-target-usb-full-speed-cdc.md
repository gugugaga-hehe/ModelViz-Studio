# Throughput target: a gyro-rate Device over USB full-speed CDC

The live pipeline is designed for roughly 4–8 kHz frames carrying a dozen or more Fields, because the tool is used to debug products such as an STM32F407VET6 streaming over USB OTG full-speed (CDC). That link tops out around 1 MB/s in practice, so the server must sustain about that byte rate end-to-end (decode, record, forward to the browser) without dropping data, and the browser must render at display rate rather than per frame.
