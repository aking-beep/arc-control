/** jsonBlock() wrapped in <details>: closed on screen, forced open in print. */
export function RawJson({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="rounded-md border border-line bg-surface">
      <summary className="px-3 py-2 text-[13px] font-semibold">{label}</summary>
      <pre className="mono max-h-[420px] overflow-auto border-t border-line bg-sunk px-4 py-3 leading-relaxed">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
