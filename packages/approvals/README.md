# @arc-control/approvals

The human-in-the-loop lifecycle for actions a policy will not authorize on its
own.

## Why this package exists

`REQUIRE_APPROVAL` is the effect that earns its place in the model. Without
it, every judgement call has to be decided in advance — which in practice means
pre-approved, because the organization picks the answer that does not block
work.

## The decisions worth knowing

All four are enforced here rather than left to the console, because a control
that the UI implements is a control the API does not have.

**Authority.** Only an approver the policy named may vote. Selectors are
`role:<role>`, `user:<identifier>`, `owner` and `*`.

**Finality.** A single rejection resolves the request: when a named approver
says no, waiting for the others cannot make the action safe. One approver
cannot vote twice to reach a threshold alone.

**Single use.** A grant is *consumed* when the action executes, under the
approvals store's lock. So one approval can authorize exactly one execution,
even when two callers race to release it — asserted in the evals with three
simultaneous resumes. Claiming and executing are separate steps, so a crash
between them leaves a consumed approval rather than a replayable one.

**Separation of duties.** `requireSeparationOfDuties` bars the agent's
registered owner *however else they would match*, including through a role they
happen to hold. Matching by role must not be a way around the control.

`minApprovals` is not bounded by the number of selectors:
`role:finance-manager` may match a whole team, so requiring two approvals from
one role selector is the standard dual-control pattern.

## Usage

```ts
import { ApprovalEngine } from '@arc-control/approvals';

const approvals = new ApprovalEngine(store);

const pending = await approvals.listPending({ approver });

await approvals.vote({ approvalId, approver, vote: 'approve', comment: 'verified' });

// Then release it through the gateway, which consumes the grant.
await gateway.resume(approvalId);
```

Approving is not itself the act. Releasing is a separate, audited step.
