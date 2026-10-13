import type { Stimulus } from "@modelviz/protocol";

/** Stimulus value at sample k (time t) for an Analysis lasting durationS at rate fs. */
export function stimulusFn(s: Stimulus, durationS: number, fs: number): (k: number, t: number) => number {
  switch (s.kind) {
    case "step":
      return (_k, t) => (t >= s.startS ? s.amplitude : 0);
    case "impulse":
      return (k) => (k === 0 ? s.area * fs : 0);
    case "sine":
      return (_k, t) => s.amplitude * Math.sin(2 * Math.PI * s.freqHz * t);
    case "chirp": {
      const rate = (s.f1Hz - s.f0Hz) / durationS;
      return (_k, t) => s.amplitude * Math.sin(2 * Math.PI * (s.f0Hz * t + 0.5 * rate * t * t));
    }
    case "sineSweep": {
      const r = Math.log(s.f1Hz / s.f0Hz) / durationS;
      return (_k, t) => s.amplitude * Math.sin(((2 * Math.PI * s.f0Hz) / r) * (Math.exp(r * t) - 1));
    }
  }
}
