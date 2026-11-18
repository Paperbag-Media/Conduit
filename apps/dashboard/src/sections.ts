/** 'footer': pinned to the bottom of the sidebar, outside the groups. */
export type SectionGroup = 'overview' | 'discord' | 'streaming' | 'planned' | 'footer';

export interface Section {
  id: string;
  label: string;
  /** The page's title, when it differs from the sidebar label (two groups have a Commands and a Giveaways). */
  title?: string;
  /** The line under the page's title. */
  summary: string;
  group: SectionGroup;
  /** Not built yet: shown with a gray "Soon" and not clickable. */
  soon?: true;
}

/**
 * Sidebar groups, in order. A group without a label has no heading (its items stand alone); a platform group carries
 * its platform's colour mark. Streaming pages have a tab per platform (Kick, Twitch, and YouTube as Soon).
 */
export const SECTION_GROUPS: ReadonlyArray<{ id: SectionGroup; label?: string; platform?: 'discord' }> = [
  { id: 'overview' },
  { id: 'discord', label: 'Discord', platform: 'discord' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'planned' },
];

/** Every page, in sidebar order. Each feature has exactly one place. */
export const SECTIONS: readonly Section[] = [
  { id: 'dashboard', label: 'Dashboard', summary: 'Connect and manage your platform accounts.', group: 'overview' },
  // The id is kept from when this page was "Discord Moderation".
  { id: 'discord-moderation', label: 'Discord Bot', summary: 'Your Discord bot: settings, protection and logs.', group: 'discord' },
  { id: 'discord-commands', label: 'Commands', title: 'Discord Commands', summary: 'Your Discord bot’s slash commands: built-in and your own, with variables.', group: 'discord' },
  { id: 'embed-creator', label: 'Embed Creator', summary: 'Build Discord messages with embeds (visually or as JSON), send them as your bot and edit them later.', group: 'discord' },
  { id: 'auto-messages', label: 'Auto Messages', summary: 'Sticky messages kept at the bottom of Discord channels, and timed messages repeated in a channel.', group: 'discord' },
  { id: 'discord-giveaways', label: 'Giveaways', title: 'Discord Giveaways', summary: 'One Discord giveaway runs at a time. Members enter with the Enter Giveaway button on its post.', group: 'discord' },
  { id: 'loyalty', label: 'Loyalty & Rewards', summary: 'Discord XP, levels and role rewards, plus a separate points balance, rewards and redemptions.', group: 'discord' },
  { id: 'commands', label: 'Commands', title: 'Stream Commands', summary: 'Default and custom chat commands for Kick and Twitch, with variables.', group: 'streaming' },
  { id: 'moderation', label: 'Moderation', summary: 'Automated protection for your Kick and Twitch chat, and its logs.', group: 'streaming' },
  { id: 'notifications', label: 'Notifications', summary: 'Discord posts when Kick or Twitch streamers — yours or anyone’s — go live.', group: 'streaming' },
  { id: 'clips', label: 'Clips', summary: 'Your channel’s clips: posted in Discord with watch buttons, and saved on this PC.', group: 'streaming' },
  { id: 'timed-messages', label: 'Timed Messages', summary: 'Messages repeated in your Kick or Twitch chat — every X minutes, after X chat messages, or both.', group: 'streaming' },
  { id: 'giveaways', label: 'Giveaways', title: 'Stream Giveaways', summary: 'One stream giveaway runs at a time. Viewers enter with !enter in Kick or Twitch chat.', group: 'streaming' },
  { id: 'widgets', label: 'Widgets', summary: 'Browser-source widgets for OBS, secured with scoped access tokens.', group: 'planned', soon: true },
  { id: 'settings', label: 'Settings', summary: 'This copy of CONDUIT: version, system status, appearance, backups, logs and release notes.', group: 'footer' },
];
