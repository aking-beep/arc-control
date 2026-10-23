import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { SCREENS, COMPONENTS } from '../data/mapping';
import { useProto } from '../state/ProtoContext';
import { StatusTag } from './StatusTag';

/** Canvas-only: where the screen in view lives in the repository. */
export function MappingPanel() {
  const location = useLocation();
  const { setMappingOpen } = useProto();
  const screen = SCREENS.find((candidate) => candidate.match.test(location.pathname));

  return (
    <aside aria-label="Repository mapping" className="flex w-[360px] shrink-0 flex-col border-l border-line bg-surface">
      <div className="flex h-14 items-center justify-between border-b border-line px-5">
        <h2 className="text-[14px] font-semibold">Repository mapping</h2>
        <button type="button" onClick={() => setMappingOpen(false)} className="btn rounded px-2 py-1 text-[13px] text-ink-soft hover:bg-sunk hover:text-ink">
          Close
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4 text-[13px]">
        {!screen ? (
          <p className="text-ink-soft">This view is canvas-only and has no repository counterpart.</p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="mono text-ink-soft">{screen.id}</span>
              <span className="font-semibold">{screen.title}</span>
              <StatusTag status={screen.status} />
            </div>
            <dl className="mt-4 space-y-3">
              <Row label="Route">
                <span className="mono">{screen.route}</span>
              </Row>
              <Row label="Ship target">
                <span className="mono break-words">{screen.repoSource}</span>
              </Row>
              <Row label="Reads">
                <ul className="space-y-0.5">
                  {screen.reads.map((read) => (
                    <li key={read} className="mono break-words">
                      {read}
                    </li>
                  ))}
                </ul>
              </Row>
              <Row label="Writes">
                {screen.writes.length === 0 ? (
                  <span className="text-ink-soft">None (read-only)</span>
                ) : (
                  screen.writes.map((write) => (
                    <p key={write} className="mono break-words">
                      {write}
                    </p>
                  ))
                )}
              </Row>
              <Row label="SDK change">{screen.sdk}</Row>
              <Row label="Backend change">None</Row>
              {screen.notes && <Row label="Note">{screen.notes}</Row>}
            </dl>
            <h3 className="mt-6 text-[12px] font-semibold text-ink-soft">Components on this screen</h3>
            <ul className="mt-2 divide-y divide-line border-y border-line">
              {screen.components.map((name) => {
                const entry = COMPONENTS.find((component) => component.name.split(', ').includes(name) || component.name === name);
                return (
                  <li key={name} className="py-2">
                    <div className="font-semibold">{name}</div>
                    {entry && (
                      <div className="mono mt-0.5 text-ink-soft">
                        {entry.helper} · {entry.location}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        <Link to="/__mapping" className="link mt-5 inline-block">
          Full component-to-repository table →
        </Link>
      </div>
    </aside>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] font-semibold text-ink-soft">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
