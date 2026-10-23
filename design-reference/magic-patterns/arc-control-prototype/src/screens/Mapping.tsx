import { Link } from 'react-router-dom';
import { COMPONENTS, SCREENS } from '../data/mapping';
import { PageHeader, SectionTitle } from '../components/PageHeader';
import { StatusTag } from '../components/StatusTag';

/** Canvas-only: full component-to-repository mapping. Never ships. */
export function Mapping() {
  return (
    <>
      <PageHeader
        title="Repository mapping"
        lede="Canvas-only reference. Source of truth: aking-beep/arc-control @ d998a110. Each prototype component maps to a server-rendered template helper in apps/control-console; no backend file changes."
      />
      <h2 className="mb-3 text-[16px] font-[650]">Screens</h2>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="dt compact">
          <caption className="sr-only">Screens to repository</caption>
          <thead>
            <tr>
              <th scope="col">ID</th>
              <th scope="col">Screen</th>
              <th scope="col">Status</th>
              <th scope="col">Route</th>
              <th scope="col">Ship target</th>
              <th scope="col">Reads</th>
              <th scope="col">SDK change</th>
            </tr>
          </thead>
          <tbody>
            {SCREENS.map((s) => (
              <tr key={s.id}>
                <td className="mono">{s.id}</td>
                <td className="whitespace-nowrap font-semibold">
                  {s.route.startsWith('/') && !s.route.includes(':') && !s.route.includes('…') ? (
                    <Link to={s.route} className="link">
                      {s.title}
                    </Link>
                  ) : (
                    s.title
                  )}
                </td>
                <td>
                  <StatusTag status={s.status} />
                </td>
                <td className="mono whitespace-nowrap">{s.route}</td>
                <td className="mono">{s.repoSource}</td>
                <td className="mono">{s.reads.join(' · ') || '—'}</td>
                <td className="text-[13px]">{s.sdk}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionTitle>Components</SectionTitle>
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="dt compact">
          <caption className="sr-only">Components to template helpers</caption>
          <thead>
            <tr>
              <th scope="col">Prototype component</th>
              <th scope="col">Template helper (ship target)</th>
              <th scope="col">Exists?</th>
              <th scope="col">Repo location</th>
              <th scope="col">Prototype file</th>
            </tr>
          </thead>
          <tbody>
            {COMPONENTS.map((c) => (
              <tr key={c.name}>
                <td className="font-semibold">{c.name}</td>
                <td className="mono">{c.helper}</td>
                <td className={c.exists === 'New' ? 'text-info' : c.exists === 'Canvas only' ? 'text-proto' : ''}>{c.exists}</td>
                <td className="mono">{c.location}</td>
                <td className="mono text-ink-soft">{c.file}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <SectionTitle>Preserved, unchanged</SectionTitle>
      <ul className="list-disc space-y-1 pl-5 text-[13px]">
        <li>No file changes under apps/control-api, packages/* (except additive read-only SDK methods), connectors, schemas, evals.</li>
        <li>POST paths and form fields (vote, comment) unchanged; vote → execute only if approved (server.ts:159-165).</li>
        <li>CSP default-src 'none' unchanged: no script, no external fonts or images. Every interaction works without JavaScript.</li>
        <li>Escape-by-default html templating; parameters shown as returned (redacted); credential secrets never present.</li>
        <li>Zero runtime dependencies (check-dependencies.mjs). Work goes to a feature branch and PR; no commit to default branch, no deploy.</li>
      </ul>
    </>
  );
}
