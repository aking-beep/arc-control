import { Link, useLocation, useParams } from 'react-router-dom';
import { API_BASE } from '../data/seed';

const TITLES: Record<number, string> = {
  404: 'Not found',
  405: 'Method not allowed',
  502: 'The control API could not be reached',
};

/** S10 — errorPage (pages.ts:414). Message shown verbatim. */
export function ErrorScreen({ status, message }: { status?: number; message?: string }) {
  const params = useParams();
  const location = useLocation();
  const code = status ?? (Number(params.status) || 404);
  const text = message ?? (code === 502 ? 'The control API could not be reached: connect ECONNREFUSED 127.0.0.1:8787' : `no page at ${location.pathname}`);
  return (
    <div className="max-w-[640px] pt-6">
      <p className="mono tnum text-[13px] text-ink-soft">{code}</p>
      <h1 className="mt-1 text-[22px] font-[650]">{TITLES[code] ?? 'Error'}</h1>
      <p className="mono mt-3 rounded-md bg-sunk px-3 py-2 text-ink">{text}</p>
      <p className="mt-3 text-[13px] text-ink-soft">
        API base <span className="mono">{API_BASE}</span>
      </p>
      <p className="mt-5 flex gap-5 text-[14px]">
        <Link to={location.pathname} className="link">
          Retry
        </Link>
        <Link to="/" className="link">
          ← Overview
        </Link>
      </p>
    </div>
  );
}
