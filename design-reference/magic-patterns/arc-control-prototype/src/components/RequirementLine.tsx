import type { ApprovalRequirement } from '../data/types';

/** requirementLine(requirement) — ApprovalRequirement from schemas/src/policy.ts. */
export function RequirementLine({ requirement, compact }: { requirement: ApprovalRequirement; compact?: boolean }) {
  const approvers = requirement.approvers.map(describeApprover).join(' or ');
  if (compact) {
    return (
      <span className="text-[13px]">
        <span className="tnum">{requirement.minApprovals}</span> of <span className="mono">{requirement.approvers.join(', ')}</span>
        {requirement.requireSeparationOfDuties && ' · SoD'}
        {requirement.expiresInSeconds !== undefined && ` · expires after ${Math.round(requirement.expiresInSeconds / 60)} min`}
      </span>
    );
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      <dt className="text-ink-soft">Required</dt>
      <dd>
        <span className="tnum font-semibold">{requirement.minApprovals}</span> approval{requirement.minApprovals === 1 ? '' : 's'} from {approvers}
      </dd>
      <dt className="text-ink-soft">Separation of duties</dt>
      <dd>{requirement.requireSeparationOfDuties ? 'On: the agent owner may not approve' : 'Off'}</dd>
      {requirement.expiresInSeconds !== undefined && (
        <>
          <dt className="text-ink-soft">Window</dt>
          <dd className="tnum">{Math.round(requirement.expiresInSeconds / 60)} min from request</dd>
        </>
      )}
    </dl>
  );
}

function describeApprover(selector: string): string {
  if (selector.startsWith('role:')) return `role ${selector.slice(5)}`;
  if (selector.startsWith('user:')) return selector.slice(5);
  if (selector === 'owner') return 'the agent owner';
  return selector;
}
