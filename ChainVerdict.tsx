import type { ChainVerification } from '../data/types';
import { DigestBlock } from './DigestBlock';

/** Chain block in auditPage (pages.ts:380-405). Caveat kept in meaning (TRUST_MODEL.md). */
export function ChainVerdict({ verification, compact }: { verification: ChainVerification; compact?: boolean }) {
  const ok = verification.valid;
  return (
    <div className={`rounded-lg border ${ok ? 'border-line bg-surface' : 'border-deny/50 bg-deny-bg'} px-5 py-4`}>
      <p className="text-[18px] font-[650]">
        Chain {ok ? <span className="text-allow">intact</span> : <span className="text-deny">BROKEN</span>}
        <span className="ml-2 text-[14px] font-normal text-ink-soft">
          {ok
            ? `${verification.recordsChecked} record(s) verified`
            : `${verification.failures.length} problem(s) in ${verification.recordsChecked} record(s)`}
        </span>
      </p>
      {!ok && (
        <table className="dt compact mt-3 rounded-md border border-deny/30 bg-surface">
          <caption className="sr-only">Chain verification failures</caption>
          <thead>
            <tr>
              <th scope="col">Sequence</th>
              <th scope="col">Problem</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {verification.failures.map((f) => (
              <tr key={`${f.sequence}-${f.problem}`}>
                <td className="mono tnum">{f.sequence}</td>
                <td className="mono font-semibold text-deny">{f.problem}</td>
                <td>{f.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {verification.headDigest && (
        <div className="mt-3">
          <DigestBlock label="head digest" value={verification.headDigest} note={verification.headSequence !== undefined ? `sequence ${verification.headSequence}` : undefined} />
        </div>
      )}
      {!compact && (
        <p className="mt-3 max-w-[100ch] text-[13px] leading-relaxed text-ink-soft">
          {verification.checkedAgainstExpectation
            ? 'Checked against a recorded head, so truncation of the log would have been detected. '
            : 'Checked against itself only. This detects an edited record and a record missing from the middle, but not truncation: removing entries from the end leaves a shorter chain that still verifies. '}
          This is tamper evidence, not tamper proofing: an attacker who controls the storage can rewrite the whole chain and recompute every
          digest. Recording the head digest above somewhere ARC Control cannot reach is what closes both gaps.
        </p>
      )}
    </div>
  );
}
