import { NavLink, useLocation } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';

const GROUPS: { label: string; items: { to: string; label: string; isNew?: boolean }[] }[] = [
  { label: 'Operate', items: [{ to: '/', label: 'Overview' }, { to: '/approvals', label: 'Approvals' }] },
  { label: 'Inventory', items: [{ to: '/agents', label: 'Agents' }, { to: '/tools', label: 'Tools', isNew: true }] },
  { label: 'Govern', items: [{ to: '/policies', label: 'Policies' }, { to: '/access', label: 'Access', isNew: true }] },
  { label: 'Record', items: [{ to: '/evidence', label: 'Evidence' }, { to: '/audit', label: 'Audit' }] },
  { label: 'Assure', items: [{ to: '/security', label: 'Security', isNew: true }, { to: '/reports', label: 'Reports', isNew: true }] },
];

/** NAVIGATION in render.ts, regrouped. Section names kept as-is (plan §3). */
export function NavRail() {
  const { approvals } = useProto();
  const location = useLocation();
  const pending = approvals.filter((a) => a.status === 'pending').length;

  const isActive = (to: string) => (to === '/' ? location.pathname === '/' : location.pathname.startsWith(to));

  return (
    <nav aria-label="Console" className="flex w-[216px] shrink-0 flex-col border-r border-line bg-sunk">
      <div className="flex h-14 items-center gap-2.5 border-b border-line px-5">
        <span aria-hidden className="h-4 w-4 rounded-[3px] bg-accent" />
        <span className="text-[15px] tracking-tight">
          ARC <strong className="font-semibold">Control</strong>
        </span>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-4">
        {GROUPS.map((group) => (
          <div key={group.label} className="mb-4">
            <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-soft">{group.label}</div>
            <ul>
              {group.items.map((item) => {
                const active = isActive(item.to);
                return (
                  <li key={item.to}>
                    <NavLink
                      to={item.to}
                      end={item.to === '/'}
                      aria-current={active ? 'page' : undefined}
                      className={`btn relative flex h-8 items-center justify-between rounded-md px-2 text-[14px] ${
                        active ? 'bg-surface font-semibold text-ink' : 'text-ink-soft hover:bg-surface hover:text-ink'
                      }`}
                    >
                      {active && <span aria-hidden className="absolute inset-y-1.5 left-0 w-[2px] rounded bg-accent" />}
                      <span>{item.label}</span>
                      {item.to === '/approvals' && pending > 0 && (
                        <span className="tnum text-[13px] font-semibold text-approval">
                          {pending}
                          <span className="sr-only"> pending</span>
                        </span>
                      )}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line px-5 py-3 text-[12px] text-ink-soft">
        Theme follows the system setting
      </div>
    </nav>
  );
}
