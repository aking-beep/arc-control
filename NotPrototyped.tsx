const ITEMS = [
  { name: 'Login, SSO, operator RBAC, user menu', why: 'Single shared operator token (v0.5). Designing it would misstate the trust model.' },
  { name: 'Multi-org switcher', why: 'organizationId is not enforced (v0.5).' },
  { name: 'Live updates, alerting, SIEM', why: 'No push channel, and the CSP allows no JavaScript (v0.3 / v0.5).' },
  { name: 'Cost attribution', why: 'Not captured (v0.3). A frame would invite invented numbers.' },
  { name: 'Credential vs. permission analysis', why: 'Not built (v0.2).' },
  { name: 'Policy authoring, agent and tool registration', why: 'Write APIs exist but are outside this read-and-govern redesign; needs a separate decision.' },
];

export function NotPrototyped() {
  return (
    <section>
      <h2 className="text-[18px] font-[650]">Deliberately not prototyped</h2>
      <p className="mt-1 text-[13px] text-ink-soft">Listed so their absence reads as a decision, not an oversight.</p>
      <table className="dt mt-4 rounded-lg border border-line bg-surface">
        <thead>
          <tr>
            <th>Capability</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {ITEMS.map((i) => (
            <tr key={i.name}>
              <td className="w-[36%] font-semibold">{i.name}</td>
              <td className="text-ink-soft">{i.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
