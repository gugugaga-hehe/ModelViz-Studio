import type { PoleZeroResult } from "@modelviz/protocol";
import { useTranslation } from "react-i18next";

/** s-plane or z-plane map: × poles, ○ zeros of the transfer to the chosen output. */
export function PoleZeroPlot({ result, output }: { result: PoleZeroResult; output: string }) {
  const { t } = useTranslation();
  const zeros = result.zeros[output] ?? [];
  const pts = [...result.poles, ...zeros];
  const discrete = result.domain === "discrete";
  let r = Math.max(discrete ? 1.2 : 1, ...pts.map((p) => Math.max(Math.abs(p.re), Math.abs(p.im)))) * 1.15;
  if (!Number.isFinite(r)) r = 1;
  const size = 320;
  const sx = (x: number) => ((x + r) / (2 * r)) * size;
  const sy = (y: number) => ((r - y) / (2 * r)) * size;
  const tick = (Math.abs(r) > 0 ? 10 ** Math.floor(Math.log10(r)) : 1);
  return (
    <figure className="flex flex-col items-center gap-1 text-xs" data-testid="pole-zero-plot" data-poles={result.poles.length} data-zeros={zeros.length}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={t("pz.title")} className="rounded border border-border bg-surface">
        <line x1={0} y1={sy(0)} x2={size} y2={sy(0)} stroke="var(--mv-border)" />
        <line x1={sx(0)} y1={0} x2={sx(0)} y2={size} stroke="var(--mv-border)" />
        {discrete && <circle cx={sx(0)} cy={sy(0)} r={sx(1) - sx(0)} fill="none" stroke="var(--mv-muted)" strokeDasharray="4 4" />}
        {!discrete && <rect x={sx(0)} y={0} width={size - sx(0)} height={size} fill="var(--mv-danger)" opacity={0.05} />}
        <text x={sx(tick) + 2} y={sy(0) - 3} fill="var(--mv-muted)" fontSize={10}>
          {tick}
        </text>
        {zeros.map((z, i) => (
          <circle key={`z${i}`} cx={sx(z.re)} cy={sy(z.im)} r={5} fill="none" stroke="var(--mv-accent)" strokeWidth={2} />
        ))}
        {result.poles.map((p, i) => (
          <g key={`p${i}`} stroke="var(--mv-danger)" strokeWidth={2}>
            <line x1={sx(p.re) - 5} y1={sy(p.im) - 5} x2={sx(p.re) + 5} y2={sy(p.im) + 5} />
            <line x1={sx(p.re) - 5} y1={sy(p.im) + 5} x2={sx(p.re) + 5} y2={sy(p.im) - 5} />
          </g>
        ))}
      </svg>
      <figcaption className={result.stable ? "text-ok" : "text-danger"}>
        {t(discrete ? "pz.zPlane" : "pz.sPlane")} · {t(result.stable ? "pz.stable" : "pz.unstable")}
      </figcaption>
    </figure>
  );
}
