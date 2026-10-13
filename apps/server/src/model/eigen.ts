/**
 * Eigenvalues of a small real matrix: reduction to upper Hessenberg form by stabilised
 * elementary similarity transforms, then the shifted QR algorithm (Francis double shift).
 */
export interface Complex {
  re: number;
  im: number;
}

function hessenberg(a: number[][]): void {
  const n = a.length;
  for (let m = 1; m < n - 1; m++) {
    let x = 0;
    let i = m;
    for (let j = m; j < n; j++) {
      if (Math.abs(a[j]![m - 1]!) > Math.abs(x)) {
        x = a[j]![m - 1]!;
        i = j;
      }
    }
    if (i !== m) {
      for (let j = m - 1; j < n; j++) [a[i]![j], a[m]![j]] = [a[m]![j]!, a[i]![j]!];
      for (let j = 0; j < n; j++) [a[j]![i], a[j]![m]] = [a[j]![m]!, a[j]![i]!];
    }
    if (x !== 0) {
      for (let k = m + 1; k < n; k++) {
        let y = a[k]![m - 1]!;
        if (y !== 0) {
          y /= x;
          a[k]![m - 1] = y;
          for (let j = m; j < n; j++) a[k]![j]! -= y * a[m]![j]!;
          for (let j = 0; j < n; j++) a[j]![m]! += y * a[j]![k]!;
        }
      }
    }
  }
  for (let i = 2; i < n; i++) for (let j = 0; j < i - 1; j++) a[i]![j] = 0;
}

export function eigenvalues(input: number[][]): Complex[] {
  const n = input.length;
  if (n === 0) return [];
  const a = input.map((r) => [...r]);
  hessenberg(a);
  const out: Complex[] = [];
  let nn = n - 1;
  let t = 0;
  let anorm = 0;
  for (let i = 0; i < n; i++) for (let j = Math.max(i - 1, 0); j < n; j++) anorm += Math.abs(a[i]![j]!);
  let p = 0;
  let q = 0;
  let r = 0;
  while (nn >= 0) {
    let its = 0;
    let l: number;
    do {
      for (l = nn; l >= 1; l--) {
        const s = Math.abs(a[l - 1]![l - 1]!) + Math.abs(a[l]![l]!);
        if (Math.abs(a[l]![l - 1]!) <= Number.EPSILON * (s === 0 ? anorm : s)) {
          a[l]![l - 1] = 0;
          break;
        }
      }
      const x = a[nn]![nn]!;
      if (l === nn) {
        out.push({ re: x + t, im: 0 });
        nn--;
      } else {
        const y = a[nn - 1]![nn - 1]!;
        const w = a[nn]![nn - 1]! * a[nn - 1]![nn]!;
        if (l === nn - 1) {
          p = 0.5 * (y - x);
          q = p * p + w;
          const z = Math.sqrt(Math.abs(q));
          const xx = x + t;
          if (q >= 0) {
            const zz = p + (p >= 0 ? Math.abs(z) : -Math.abs(z));
            out.push({ re: xx + zz, im: 0 });
            out.push({ re: zz !== 0 ? xx - w / zz : xx + zz, im: 0 });
          } else {
            out.push({ re: xx + p, im: z });
            out.push({ re: xx + p, im: -z });
          }
          nn -= 2;
        } else {
          if (its === 60) throw new Error("Eigenvalue iteration did not converge");
          let xs = x;
          let ys = y;
          let ws = w;
          if (its === 10 || its === 20) {
            t += xs;
            for (let i = 0; i <= nn; i++) a[i]![i]! -= xs;
            const s = Math.abs(a[nn]![nn - 1]!) + Math.abs(a[nn - 1]![nn - 2]!);
            xs = ys = 0.75 * s;
            ws = -0.4375 * s * s;
          }
          its++;
          let m: number;
          for (m = nn - 2; m >= l; m--) {
            const z = a[m]![m]!;
            r = xs - z;
            const s = ys - z;
            p = (r * s - ws) / a[m + 1]![m]! + a[m]![m + 1]!;
            q = a[m + 1]![m + 1]! - z - r - s;
            r = a[m + 2]![m + 1]!;
            const sc = Math.abs(p) + Math.abs(q) + Math.abs(r);
            p /= sc;
            q /= sc;
            r /= sc;
            if (m === l) break;
            const u = Math.abs(a[m]![m - 1]!) * (Math.abs(q) + Math.abs(r));
            const v = Math.abs(p) * (Math.abs(a[m - 1]![m - 1]!) + Math.abs(z) + Math.abs(a[m + 1]![m + 1]!));
            if (u <= Number.EPSILON * v) break;
          }
          for (let i = m + 2; i <= nn; i++) {
            a[i]![i - 2] = 0;
            if (i !== m + 2) a[i]![i - 3] = 0;
          }
          for (let k = m; k <= nn - 1; k++) {
            let scale = 0;
            if (k !== m) {
              p = a[k]![k - 1]!;
              q = a[k + 1]![k - 1]!;
              r = k !== nn - 1 ? a[k + 2]![k - 1]! : 0;
              scale = Math.abs(p) + Math.abs(q) + Math.abs(r);
              if (scale !== 0) {
                p /= scale;
                q /= scale;
                r /= scale;
              }
            }
            const norm = Math.sqrt(p * p + q * q + r * r);
            const s = p >= 0 ? norm : -norm;
            if (s === 0) continue;
            if (k === m) {
              if (l !== m) a[k]![k - 1] = -a[k]![k - 1]!;
            } else {
              a[k]![k - 1] = -s * scale;
            }
            p += s;
            const x2 = p / s;
            const y2 = q / s;
            const z2 = r / s;
            q /= p;
            r /= p;
            for (let j = k; j <= nn; j++) {
              let pp = a[k]![j]! + q * a[k + 1]![j]!;
              if (k !== nn - 1) {
                pp += r * a[k + 2]![j]!;
                a[k + 2]![j]! -= pp * z2;
              }
              a[k + 1]![j]! -= pp * y2;
              a[k]![j]! -= pp * x2;
            }
            const mmin = nn < k + 3 ? nn : k + 3;
            for (let i = l; i <= mmin; i++) {
              let pp = x2 * a[i]![k]! + y2 * a[i]![k + 1]!;
              if (k !== nn - 1) {
                pp += z2 * a[i]![k + 2]!;
                a[i]![k + 2]! -= pp * r;
              }
              a[i]![k + 1]! -= pp * q;
              a[i]![k]! -= pp;
            }
          }
        }
      }
    } while (l < nn - 1);
  }
  return out;
}
