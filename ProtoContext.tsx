import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { fakeDigest, fakeId } from '../lib/digest';
import {
  OPERATOR,
  SEED_AGENTS,
  SEED_APPROVALS,
  SEED_AUDIT,
  SEED_CREDENTIALS,
  SEED_EVIDENCE,
  SEED_POLICIES,
  SEED_TOOLS,
  SEED_TRACES,
  VERSION,
} from '../data/seed';
import type {
  Agent,
  AgentCredential,
  ApprovalRequest,
  AuditEventType,
  AuditRecord,
  ChainVerification,
  EvidenceRecord,
  Health,
  Policy,
  RuleTrace,
  Tool,
} from '../data/types';

/**
 * Prototype state. Stands in for the control API so the existing user
 * journeys (vote → execute, suspend/resume, enable/disable) can be walked
 * through. The rules applied below are the ones the engines enforce
 * server-side; the console only displays their result.
 */

export type Scenario = 'seed' | 'chain-broken' | 'connector-drift';
export type Theme = 'light' | 'dark';
export type BannerKind = 'success' | 'error' | 'info';

export interface Banner {
  kind: BannerKind;
  message: string;
  nonce?: number;
}

interface ProtoState {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  scenario: Scenario;
  setScenario: (scenario: Scenario) => void;
  mappingOpen: boolean;
  setMappingOpen: (open: boolean) => void;
  banner?: Banner;
  setBanner: (banner?: Banner) => void;

  agents: Agent[];
  credentials: AgentCredential[];
  tools: Tool[];
  policies: Policy[];
  approvals: ApprovalRequest[];
  evidence: EvidenceRecord[];
  audit: AuditRecord[];
  traces: Record<string, RuleTrace[]>;
  health: Health;
  verification: ChainVerification;

  setAgentStatus: (id: string, status: Agent['status']) => void;
  setPolicyEnabled: (id: string, enabled: boolean) => void;
  vote: (id: string, choice: 'approve' | 'reject', comment?: string) => void;
}

const Ctx = createContext<ProtoState | null>(null);

export function ProtoProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>('light');
  const [scenario, setScenario] = useState<Scenario>('seed');
  const [mappingOpen, setMappingOpen] = useState(false);
  const [banner, setBannerRaw] = useState<Banner | undefined>();
  const setBanner = useCallback((next?: Banner) => setBannerRaw(next ? { ...next, nonce: Math.random() } : undefined), []);
  const [agents, setAgents] = useState(SEED_AGENTS);
  const [policies, setPolicies] = useState(SEED_POLICIES);
  const [approvals, setApprovals] = useState(SEED_APPROVALS);
  const [evidence, setEvidence] = useState(SEED_EVIDENCE);
  const [audit, setAudit] = useState(SEED_AUDIT);

  const appendAudit = useCallback((events: { type: AuditEventType; actor: string; subject: string; summary: string }[]) => {
    setAudit((current) => {
      const next = [...current];
      for (const event of events) {
        const last = next[next.length - 1];
        const sequence = (last?.sequence ?? 0) + 1;
        next.push({
          id: fakeId('arc_aud', `${sequence}-live`),
          sequence,
          type: event.type,
          organizationId: 'org_default',
          occurredAt: new Date().toISOString(),
          actor: event.actor,
          subject: event.subject,
          summary: event.summary,
          data: {},
          previousDigest: last?.digest ?? '',
          digest: fakeDigest(`audit-live-${sequence}-${event.type}`),
        });
      }
      return next;
    });
  }, []);

  const setAgentStatus = useCallback(
    (id: string, status: Agent['status']) => {
      setAgents((current) => current.map((agent) => (agent.id === id ? { ...agent, status, updatedAt: new Date().toISOString() } : agent)));
      const agent = agents.find((candidate) => candidate.id === id);
      appendAudit([
        {
          type: status === 'suspended' ? 'agent.suspended' : 'agent.resumed',
          actor: OPERATOR.identity,
          subject: id,
          summary: `${OPERATOR.identity} ${status === 'suspended' ? 'suspended' : 'resumed'} agent "${agent?.name ?? id}"`,
        },
      ]);
      // server.ts:175 — notice text unchanged.
      setBanner({ kind: 'success', message: `Agent ${status === 'suspended' ? 'suspend' : 'resume'}ed.` });
    },
    [agents, appendAudit],
  );

  const setPolicyEnabled = useCallback(
    (id: string, enabled: boolean) => {
      setPolicies((current) => current.map((policy) => (policy.id === id ? { ...policy, enabled } : policy)));
      appendAudit([
        {
          type: enabled ? 'policy.updated' : 'policy.disabled',
          actor: OPERATOR.identity,
          subject: id,
          summary: `${OPERATOR.identity} ${enabled ? 'enabled' : 'disabled'} policy ${id}`,
        },
      ]);
      // server.ts:182
      setBanner({ kind: 'success', message: `Policy ${enabled ? 'enable' : 'disable'}d.` });
    },
    [appendAudit],
  );

  const vote = useCallback(
    (id: string, choice: 'approve' | 'reject', comment?: string) => {
      const request = approvals.find((candidate) => candidate.id === id);
      if (!request) return;
      // approvals/src/engine.ts: a resolved request returns `conflict`.
      if (request.status !== 'pending') {
        setBanner({ kind: 'error', message: `conflict: approval ${id} is already ${request.status}` });
        return;
      }
      const now = new Date().toISOString();
      const votes = [...request.votes, { approver: OPERATOR.identity, vote: choice, ...(comment ? { comment } : {}), votedAt: now }];
      const approveCount = votes.filter((v) => v.vote === 'approve').length;
      const status = choice === 'reject' ? 'rejected' : approveCount >= request.requirement.minApprovals ? 'approved' : 'pending';

      const events: { type: AuditEventType; actor: string; subject: string; summary: string }[] = [
        { type: 'approval.voted', actor: OPERATOR.identity, subject: id, summary: `${OPERATOR.identity} voted ${choice}` },
      ];

      if (status === 'rejected') {
        events.push({ type: 'approval.rejected', actor: 'system', subject: id, summary: 'approval rejected; the action will not run' });
        setApprovals((current) => current.map((a) => (a.id === id ? { ...a, votes, status, resolvedAt: now } : a)));
        appendAudit(events);
        setBanner({ kind: 'success', message: 'Recorded: reject.' });
        return;
      }

      if (status === 'approved') {
        // server.ts:159-165 — approve, then execute only because status is `approved`.
        const original = evidence.find((record) => record.approval?.id === id);
        const durationMs = 431;
        const consumed = new Date(Date.now() + durationMs).toISOString();
        setApprovals((current) => current.map((a) => (a.id === id ? { ...a, votes, status, resolvedAt: now, consumedAt: consumed } : a)));
        if (original) {
          const executed: EvidenceRecord = {
            ...original,
            id: fakeId('arc_ev', `${id}-executed`),
            approval: { ...original.approval!, status: 'approved', votes: votes.map(({ approver, vote: v, votedAt }) => ({ approver, vote: v, votedAt })), resolvedAt: now },
            execution: {
              id: fakeId('arc_exe', id),
              connector: original.tool.connector,
              status: 'succeeded',
              startedAt: now,
              finishedAt: consumed,
              durationMs,
              resultDigest: fakeDigest(`${id}-result`),
            },
            outcome: 'executed',
            createdAt: consumed,
            integrityDigest: fakeDigest(`${id}-integrity-executed`),
          };
          setEvidence((current) => [executed, ...current]);
          events.push(
            { type: 'approval.approved', actor: 'system', subject: id, summary: 'approval granted' },
            { type: 'action.executed', actor: 'system', subject: original.actionId, summary: `${original.tool.name} executed via ${original.tool.connector} in ${durationMs} ms` },
            { type: 'evidence.recorded', actor: 'system', subject: executed.id, summary: 'evidence recorded: executed' },
          );
        }
        appendAudit(events);
        setBanner({ kind: 'success', message: 'Action executed.' });
        return;
      }

      setApprovals((current) => current.map((a) => (a.id === id ? { ...a, votes } : a)));
      appendAudit(events);
      setBanner({ kind: 'success', message: `Recorded: ${choice}.` });
    },
    [approvals, evidence, appendAudit],
  );

  const health = useMemo<Health>(() => {
    const connectors: Health['connectors'] = [{ name: 'simulation', healthy: true }];
    if (scenario === 'connector-drift') {
      // connectors/mcp/src/connector.ts:119-133, verbatim detail.
      connectors.push({ name: 'mcp:docs.example.com', healthy: false, detail: 'the advertised tool surface no longer matches the pinned manifest' });
    }
    return {
      status: connectors.every((c) => c.healthy) ? 'ok' : 'degraded',
      version: VERSION,
      operatorAuthConfigured: true,
      counts: { agents: agents.length, tools: SEED_TOOLS.length, policies: policies.length, auditRecords: audit.length },
      connectors,
    };
  }, [scenario, agents.length, policies.length, audit.length]);

  const verification = useMemo<ChainVerification>(() => {
    const head = audit[audit.length - 1];
    if (scenario === 'chain-broken') {
      const target = audit[13];
      return {
        valid: false,
        recordsChecked: audit.length,
        failures: [
          { sequence: target.sequence, id: target.id, problem: 'digest_mismatch', detail: 'stored digest does not match the recomputed digest of this record' },
          { sequence: target.sequence + 1, id: audit[14].id, problem: 'broken_link', detail: 'previousDigest does not match the digest of the record before it' },
        ],
        headDigest: head?.digest,
        headSequence: head?.sequence,
        checkedAgainstExpectation: false,
      };
    }
    return { valid: true, recordsChecked: audit.length, failures: [], headDigest: head?.digest, headSequence: head?.sequence, checkedAgainstExpectation: false };
  }, [scenario, audit]);

  const value: ProtoState = {
    theme,
    setTheme,
    scenario,
    setScenario,
    mappingOpen,
    setMappingOpen,
    banner,
    setBanner,
    agents,
    credentials: SEED_CREDENTIALS,
    tools: SEED_TOOLS,
    policies,
    approvals,
    evidence,
    audit,
    traces: SEED_TRACES,
    health,
    verification,
    setAgentStatus,
    setPolicyEnabled,
    vote,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useProto(): ProtoState {
  const value = useContext(Ctx);
  if (!value) throw new Error('useProto outside ProtoProvider');
  return value;
}
