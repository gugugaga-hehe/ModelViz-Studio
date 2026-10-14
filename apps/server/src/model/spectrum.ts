import type { SpectrumRequest, SpectrumResult, SpectrumWindow } from "@modelviz/protocol";
import { ProtocolFailure } from "../errors.ts";

/** Window coefficients for an N-point periodic (DFT-even) window. */
function windowCoefficients(kind: SpectrumWindow, n: number): Float64Array {
  const w = new Float64Array(n);
  const cos = (a: number[]) => {
    for (let i = 0; i < n; i++) {
      const x = (2 * Math.PI * i) / n;
      let v = 0;
      for (let k = 0; k < a.length; k++) v += (k % 2 ? -1 : 1) * a[k]! * Math.cos(k * x);
      w[i] = v;
    }
  };
  switch (kind) {
    case "rectangular":
      w.fill(1);
      break;
    case "hann":
      cos([0.5, 0.5]);
      break;
    case "hamming":
      cos([0.54, 0.46]);
      break;
    case "blackman":
      cos([0.42, 0.5, 0.08]);
      break;
    case "flattop":
      // SRS / HFT-style 5-term flat top (as in scipy.signal.windows.flattop)
      cos([0.21557895, 0.41663158, 0.277263158, 0.083578947, 0.006947368]);
      break;
  }
  return w;
}

/** In-place iterative radix-2 FFT; n must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const a = start + k;
        const b = a + half;
        const c = Math.cos(step * k);
        const s = Math.sin(step * k);
        const tr = re[b]! * c - im[b]! * s;
        const ti = re[b]! * s + im[b]! * c;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
      }
    }
  }
}

/**
 * The newest samples on a uniform grid: sample times may jitter (Host Timestamps) or have
 * gaps, so values are linearly interpolated at the median sample interval.
 */
function uniform(times: number[], values: number[], count: number): { y: Float64Array; fs: number } {
  const n = times.length;
  const dts: number[] = [];
  for (let i = Math.max(1, n - count); i < n; i++) dts.push(times[i]! - times[i - 1]!);
  dts.sort((a, b) => a - b);
  const dtMs = dts[Math.floor(dts.length / 2)]!;
  if (!(dtMs > 0)) throw new ProtocolFailure("invalid_params", "Sample times must increase");
  const end = times[n - 1]!;
  // tolerance: (end − start) / dt of N evenly spaced samples can come out as N − 1 − ε
  const m = Math.min(count, Math.floor((end - times[0]!) / dtMs + 1e-6) + 1);
  const y = new Float64Array(m);
  let j = n - 1;
  for (let i = m - 1; i >= 0; i--) {
    const t = end - (m - 1 - i) * dtMs;
    while (j > 0 && times[j - 1]! >= t) j--;
    // t lies in [times[j-1], times[j]]
    const t0 = times[Math.max(0, j - 1)]!;
    const t1 = times[j]!;
    const v0 = values[Math.max(0, j - 1)]!;
    const v1 = values[j]!;
    y[i] = t1 > t0 ? v0 + ((v1 - v0) * (t - t0)) / (t1 - t0) : v1;
  }
  return { y, fs: 1000 / dtMs };
}

export function spectrum(req: SpectrumRequest): SpectrumResult {
  const { times, values, length: N, window } = req;
  if (values.length !== times.length) throw new ProtocolFailure("invalid_params", "times and values must have the same length");
  for (const v of values) if (!Number.isFinite(v)) throw new ProtocolFailure("invalid_params", "values must be finite numbers");
  const { y, fs } = uniform(times, values, N);
  const m = y.length;
  if (req.removeMean) {
    let mean = 0;
    for (const v of y) mean += v;
    mean /= m;
    for (let i = 0; i < m; i++) y[i]! -= mean;
  }
  // window over the samples actually present; zero-padding beyond them only interpolates the spectrum
  const w = windowCoefficients(window, m);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let sumW = 0;
  let sumW2 = 0;
  for (let i = 0; i < m; i++) {
    re[i] = y[i]! * w[i]!;
    sumW += w[i]!;
    sumW2 += w[i]! * w[i]!;
  }
  fft(re, im);

  const bins = N / 2 + 1;
  const frequencies = new Array<number>(bins);
  const amplitude = new Array<number>(bins);
  const psd = new Array<number>(bins);
  for (let k = 0; k < bins; k++) {
    const mag2 = re[k]! * re[k]! + im[k]! * im[k]!;
    const oneSided = k === 0 || k === N / 2 ? 1 : 2;
    frequencies[k] = (k * fs) / N;
    // coherent gain: a sine of amplitude A peaks at A
    amplitude[k] = (oneSided * Math.sqrt(mag2)) / sumW;
    // noise gain: the PSD integrates to the variance
    psd[k] = (oneSided * mag2) / (fs * sumW2);
  }
  return {
    sampleRateHz: fs,
    length: N,
    window,
    samples: m,
    resolutionHz: fs / N,
    enbwHz: (fs * sumW2) / (sumW * sumW),
    frequencies,
    amplitude,
    psd,
  };
}
