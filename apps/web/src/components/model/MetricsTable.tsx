import { useTranslation } from "react-i18next";

/** Metric rows per output; `null` values show as "—". */
export function MetricsTable({ rows, columns, testId }: { rows: Record<string, Record<string, number | null>>; columns: { key: string; label: string; digits?: number }[]; testId?: string }) {
  const { t } = useTranslation();
  const fmt = (v: number | null | undefined, d = 3) => (v === null || v === undefined ? "—" : Number(v.toPrecision(d + 1)).toString());
  return (
    <table className="text-xs" data-testid={testId}>
      <thead className="text-muted">
        <tr>
          <th className="pr-3 text-left font-normal">{t("metrics.output")}</th>
          {columns.map((c) => (
            <th key={c.key} className="px-2 text-right font-normal">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Object.entries(rows).map(([name, m]) => (
          <tr key={name} data-testid={`metrics-${name}`}>
            <td className="pr-3 font-mono">{name}</td>
            {columns.map((c) => (
              <td key={c.key} className="px-2 text-right tabular-nums" data-metric={c.key}>
                {fmt(m[c.key], c.digits)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
