import { money } from './format';

/**
 * `actionHeadline(tool, params)` — plan §5 S3. Built only from the tool name
 * and the recorded (already redacted) parameters, with no inference. A tool
 * with no template falls back to its name.
 */
export function actionHeadline(tool: string, params: Record<string, unknown>): { verb: string; strong?: string; rest?: string } {
  if (tool === 'stripe.refund' && params.amount !== undefined && params.customer !== undefined) {
    return { verb: 'Refund', strong: money(params.amount), rest: `to ${String(params.customer)}` };
  }
  if (tool === 'stripe.get_charge' && params.chargeId !== undefined) {
    return { verb: 'Read charge', strong: String(params.chargeId) };
  }
  if (tool === 'github.create_issue' && params.repository !== undefined) {
    return { verb: 'Open an issue on', strong: String(params.repository) };
  }
  return { verb: tool };
}
