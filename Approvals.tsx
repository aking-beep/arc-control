import { useSearchParams } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';
import { OPERATOR } from '../data/seed';
import { PageHeader } from '../components/PageHeader';
import { FilterBar } from '../components/FilterBar';
import { EmptyState } from '../components/EmptyState';
import { ApprovalRequestCard } from '../components/ApprovalRequestCard';

/** S3 / S3a — the primary work surface (approvalsPage, pages.ts:218-263). */
export function Approvals() {
  const { approvals } = useProto();
  const [params] = useSearchParams();
  const mine = params.get('mine') === 'true';
  const pending = approvals.filter((a) => a.status === 'pending');
  // GET /v1/approvals?mine=true is resolved server-side from the operator's
  // configured roles; mirrored here for the prototype.
  const assigned = pending.filter((a) =>
    a.requirement.approvers.some((s) => s === `user:${OPERATOR.identity}` || (s.startsWith('role:') && OPERATOR.roles.includes(s.slice(5)))),
  );
  const shown = mine ? assigned : pending;

  return (
    <>
      <PageHeader
        title="Approvals"
        display
        lede="Actions a policy will not authorize on its own. Approving does not execute the action. Execution is a separate step, and a granted approval is consumed when it is used, so it can never authorize a second execution."
      />
      <div className="mb-5">
        <FilterBar
          label="Show"
          current={mine ? 'true' : ''}
          options={[
            { value: '', label: 'All pending', count: pending.length },
            { value: 'true', label: 'Assigned to me', count: assigned.length },
          ]}
          hrefFor={(value) => (value ? '/approvals?mine=true' : '/approvals')}
        />
      </div>
      {shown.length === 0 ? (
        <EmptyState>Nothing is waiting for a human.</EmptyState>
      ) : (
        <div className="space-y-6">
          {shown.map((request) => (
            <div key={request.id}>
              <ApprovalRequestCard request={request} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}
