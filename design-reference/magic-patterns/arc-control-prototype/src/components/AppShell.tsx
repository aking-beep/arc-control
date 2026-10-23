import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useProto } from '../state/ProtoContext';
import { PrototypeBar } from './PrototypeBar';
import { NavRail } from './NavRail';
import { Masthead } from './Masthead';
import { BannerView } from './Banner';
import { MappingPanel } from './MappingPanel';

/** layout() in render.ts — grouped rail, operator identity, banner, main. */
export function AppShell({ children }: { children: ReactNode }) {
  const { theme, banner, setBanner, mappingOpen } = useProto();
  const location = useLocation();
  const shown = useRef<{ nonce?: number; key?: string }>({});
  const mainRef = useRef<HTMLElement>(null);

  // A notice lives for one page view, like `?notice=` after a 303 redirect.
  useEffect(() => {
    if (!banner) return;
    if (shown.current.nonce !== banner.nonce) {
      shown.current = { nonce: banner.nonce, key: location.key };
    } else if (shown.current.key !== location.key) {
      setBanner(undefined);
    }
  }, [banner, location.key, setBanner]);

  // Full page loads in the real console: every navigation starts at the top.
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [location.pathname]);

  return (
    <div className={`theme-${theme} flex h-screen flex-col bg-bg text-ink`}>
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:bg-surface focus:px-3 focus:py-2">
        Skip to content
      </a>
      <PrototypeBar />
      <div className="flex min-h-0 flex-1">
        <NavRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <Masthead />
          <main id="main" ref={mainRef} className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[1360px] px-8 pb-16 pt-6">
              {banner && <BannerView banner={banner} onDismiss={() => setBanner(undefined)} />}
              {children}
            </div>
          </main>
        </div>
        {mappingOpen && <MappingPanel />}
      </div>
    </div>
  );
}
