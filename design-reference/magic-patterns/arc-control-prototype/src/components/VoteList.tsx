import type { ApprovalVote } from '../data/types';
import { timestamp } from '../lib/format';
import { Badge } from './Badges';

/** voteList(votes) */
export function VoteList({ votes }: { votes: ApprovalVote[] }) {
  if (votes.length === 0) return <p className="text-[13px] text-ink-soft">Votes: none yet</p>;
  return (
    <ul className="space-y-2">
      {votes.map((vote) => (
        <li key={`${vote.approver}-${vote.votedAt}`} className="text-[13px]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{vote.approver}</span>
            <Badge tone={vote.vote === 'approve' ? 'allow' : 'deny'}>{vote.vote}</Badge>
            <span className="mono text-ink-soft">{timestamp(vote.votedAt)}</span>
          </div>
          {vote.comment && <p className="mt-1 border-l-2 border-line-strong pl-3 text-ink-soft">“{vote.comment}”</p>}
        </li>
      ))}
    </ul>
  );
}
