import { useState, type ReactNode } from 'react';
import type { Platform } from '@conduit/shared/app/connections';
import { PlatformIcon } from './PlatformIcon';

export interface PageTab<T extends string> {
  id: T;
  label: string;
  /** Shown with the platform's mark. */
  platform?: Platform;
  /** Not built yet: shown with a gray "Soon" and not clickable. */
  soon?: boolean;
}

/** The tab last opened on a page, remembered in this window (a per-viewer convenience); the first tab by default. */
export function useRememberedTab<T extends string>(key: string, tabs: ReadonlyArray<PageTab<T>>): [T, (id: T) => void] {
  const open = tabs.filter((t) => !t.soon).map((t) => t.id);
  const [tab, setTab] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key) as T | null;
      if (saved && open.includes(saved)) return saved;
    } catch {
      // Storage unavailable: use the default.
    }
    return open[0]!;
  });
  const choose = (id: T) => {
    setTab(id);
    try {
      localStorage.setItem(key, id);
    } catch {
      // Not remembered; it still works for this session.
    }
  };
  return [tab, choose];
}

/** A page's top-level tabs (one per platform, or per kind of item), and the chosen tab's content. */
export function PageTabs<T extends string>({
  id,
  label,
  tabs,
  active,
  onChange,
  children,
}: {
  /** Element ids: `<id>-tab-<tab>` and `<id>-panel-<tab>`. */
  id: string;
  /** What the tabs are for (read by screen readers). */
  label: string;
  tabs: ReadonlyArray<PageTab<T>>;
  active: T;
  onChange: (id: T) => void;
  children: ReactNode;
}) {
  return (
    <div className="stack">
      <div className="platform-tabs" role="tablist" aria-label={label}>
        {tabs.map((t) =>
          t.soon ? (
            <span key={t.id} className="platform-tab tab-soon" aria-disabled="true" title="Coming soon">
              {t.platform && <PlatformIcon platform={t.platform} size={16} />}
              {t.label}
              <span className="nav-phase">Soon</span>
            </span>
          ) : (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`${id}-tab-${t.id}`}
              aria-selected={active === t.id}
              aria-controls={`${id}-panel-${t.id}`}
              className={`platform-tab${active === t.id ? ' active' : ''}`}
              onClick={() => onChange(t.id)}
            >
              {t.platform && <PlatformIcon platform={t.platform} size={16} />}
              {t.label}
            </button>
          ),
        )}
      </div>
      <div role="tabpanel" id={`${id}-panel-${active}`} aria-labelledby={`${id}-tab-${active}`} className="stack">
        {children}
      </div>
    </div>
  );
}

export type StreamPlatform = 'kick' | 'twitch' | 'youtube';

/** Kick, Twitch and YouTube tabs for a Streaming page; `built` lists the platforms the page works with today. */
export function streamTabs(built: ReadonlyArray<StreamPlatform>): Array<PageTab<StreamPlatform>> {
  return (
    [
      { id: 'kick', label: 'Kick', platform: 'kick' },
      { id: 'twitch', label: 'Twitch', platform: 'twitch' },
      { id: 'youtube', label: 'YouTube', platform: 'youtube' },
    ] as const
  ).map((t) => ({ ...t, soon: !built.includes(t.id) }));
}
