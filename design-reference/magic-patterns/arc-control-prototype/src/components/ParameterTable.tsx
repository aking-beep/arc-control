import type { ParameterSpec } from '../data/types';
import { formatValue } from '../lib/format';

/**
 * parameterTable(params, spec?) — values exactly as recorded (already
 * redacted by the gateway). Sensitive parameters are marked, never unredacted.
 */
export function ParameterTable({ params, spec, caption }: { params: Record<string, unknown>; spec?: ParameterSpec[]; caption: string }) {
  const entries = Object.entries(params);
  if (entries.length === 0) return <p className="text-[13px] text-ink-soft">No parameters.</p>;
  return (
    <table className="dt compact overflow-hidden rounded-md border border-line">
      <caption className="sr-only">{caption}</caption>
      <tbody>
        {entries.map(([name, value]) => {
          const sensitive = spec?.find((s) => s.name === name)?.sensitive;
          return (
            <tr key={name}>
              <th scope="row" className="mono w-[34%] !bg-sunk !text-[12.5px] !font-normal !text-ink-soft">
                {name}
                {sensitive && <span className="ml-1.5 text-[11px] font-semibold text-approval">sensitive</span>}
              </th>
              <td className="mono tnum break-all">{formatValue(value)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
