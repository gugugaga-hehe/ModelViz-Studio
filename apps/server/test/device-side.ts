// Test fixture: plays the *Device* on the far side of a Transport, producing genuine MAVLink2 bytes.
// It uses the codec only to build input bytes; assertions are made through the client protocol.
import { join } from "node:path";
import { encodeFrame, type FieldValue } from "../src/mavlink/codec.ts";
import { dialectHash, loadDialect } from "../src/mavlink/dialect.ts";

export async function deviceSide(projectPath: string) {
  const dialect = await loadDialect(join(projectPath, "dialects/bench.xml"));
  let seq = 0;
  let timeUs = 0;
  const frame = (name: string, values: Record<string, FieldValue>) =>
    encodeFrame(dialect.byName.get(name)!, values, { seq: seq++ & 0xff, sysid: 1, compid: 1 });
  return {
    hash: parseInt(dialectHash(dialect), 16),
    frame,
    dialectInfo: (hash?: number) => frame("DIALECT_INFO", { hash: hash ?? parseInt(dialectHash(dialect), 16) }),
    /** n BENCH_STATE frames at 500 Hz Device time, setpoint = start index + i. */
    benchStates(n: number, start = 0): Uint8Array {
      const parts = Array.from({ length: n }, (_, i) => {
        const f = frame("BENCH_STATE", { time_us: timeUs, setpoint: start + i, mode: 1 });
        timeUs += 2000;
        return f;
      });
      const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    },
  };
}
