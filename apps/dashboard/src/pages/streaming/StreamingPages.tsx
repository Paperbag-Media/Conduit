import { PageTabs, streamTabs, useRememberedTab, type PageTab, type StreamPlatform } from '../../components/PageTabs';
import { KickModerationPage, TwitchModerationPage } from '../community/ModerationPage';
import { KickClipsPage } from '../kick/KickClipsPage';
import { StreamNotificationsPage } from '../kick/KickNotificationsPage';

/**
 * Streaming pages with one tab per platform (YouTube shows as Soon until it's built). Each tab is the platform's own
 * page, loaded when its tab is opened; the tab last opened on each page is remembered.
 */
function StreamTabsPage({ id, tabs, children }: { id: string; tabs: ReadonlyArray<PageTab<StreamPlatform>>; children: (p: StreamPlatform) => React.ReactNode }) {
  const [tab, setTab] = useRememberedTab(`conduit.${id}Tab`, tabs);
  return (
    <PageTabs id={id} label="Platform" tabs={tabs} active={tab} onChange={setTab}>
      {children(tab)}
    </PageTabs>
  );
}

const KICK_TWITCH = streamTabs(['kick', 'twitch']);
const CLIPS = streamTabs(['kick']);

/** Streaming → Moderation: automated protection for Kick and Twitch chat, and its logs. */
export function StreamModerationPage() {
  return (
    <StreamTabsPage id="moderation" tabs={KICK_TWITCH}>
      {(p) => (p === 'kick' ? <KickModerationPage /> : p === 'twitch' ? <TwitchModerationPage /> : null)}
    </StreamTabsPage>
  );
}

/** Streaming → Notifications: Discord posts when Kick or Twitch streamers go live. */
export function StreamNotificationsTabsPage() {
  return (
    <StreamTabsPage id="notifications" tabs={KICK_TWITCH}>
      {(p) => (p === 'youtube' ? null : <StreamNotificationsPage key={p} platform={p} />)}
    </StreamTabsPage>
  );
}

/** Streaming → Clips: Kick clips today; Twitch and YouTube are Soon. */
export function StreamClipsPage() {
  return (
    <StreamTabsPage id="clips" tabs={CLIPS}>
      {(p) => (p === 'kick' ? <KickClipsPage /> : null)}
    </StreamTabsPage>
  );
}
