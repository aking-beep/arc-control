import type { Banner } from '../state/ProtoContext';

/**
 * Banner in layout(), split into success / error / info via `?kind=`.
 * Message text comes from the server unchanged. Error is role="alert".
 */
export function BannerView({ banner, onDismiss }: { banner: Banner; onDismiss: () => void }) {
  const tone =
    banner.kind === 'error'
      ? 'border-deny/40 bg-deny-bg text-deny'
      : banner.kind === 'success'
        ? 'border-allow/40 bg-allow-bg text-allow'
        : 'border-info/40 bg-info-bg text-info';
  const glyph = banner.kind === 'error' ? '✕' : banner.kind === 'success' ? '✓' : 'i';
  return (
    <div
      role={banner.kind === 'error' ? 'alert' : 'status'}
      className={`mb-5 flex items-center gap-3 rounded-lg border px-4 py-2.5 text-[14px] ${tone}`}
    >
      <span aria-hidden className="font-mono font-bold">
        {glyph}
      </span>
      <span className="font-medium">{banner.message}</span>
      <button type="button" onClick={onDismiss} className="btn ml-auto rounded px-2 text-[12px] underline-offset-2 hover:underline">
        Dismiss
      </button>
    </div>
  );
}
