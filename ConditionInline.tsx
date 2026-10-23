import type { Condition } from '../data/types';
import { conditionToText } from '../lib/conditionText';

/** ConditionText — sentence form, raw JSON in `title` for exactness. */
export function ConditionInline({ condition }: { condition: Condition }) {
  return (
    <code className="mono rounded bg-sunk px-1.5 py-0.5 text-ink" title={JSON.stringify(condition)}>
      {conditionToText(condition)}
    </code>
  );
}
