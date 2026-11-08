/** 'footer': pinned to the bottom of the sidebar, outside the groups. */
export type SectionGroup = 'overview' | 'discord' | 'kick' | 'twitch' | 'youtube' | 'planned' | 'footer';

export interface Section {
  id: string;
  label: string;
  /** The line under the page's title. */
  summary: string;
  group: SectionGroup;
  /** Not built yet: shown with a gray "Soon" and not clickable. */
  soon?: true;
}

/**
 * Sidebar groups, in order. A group without a label has no heading (its items stand alone); platform groups carry
 * their platform's colour mark; a Soon group is only its heading, with a gray "Soon".
 */
export const SECTION_GROUPS: ReadonlyArray<{ id: SectionGroup; label?: string; platform?: 'discord' | 'kick' | 'twitch' | 'youtube'; soon?: true }> = [
  { id: 'overview' },
  { id: 'discord', label: 'Discord', platform: 'discord' },
  { id: 'kick', label: 'Kick', platform: 'kick' },
  { id: 'twitch', label: 'Twitch', platform: 'twitch' },
  { id: 'youtube', label: 'YouTube', platform: 'youtube', soon: true },
  { id: 'planned' },
];

/** Every page, in sidebar order. Each feature has exactly one place: features on several platforms are under Overview. */
export const SECTIONS: readonly Section[] = [
  { id: 'dashboard', label: 'Dashboard', summary: 'Connect and manage your platform accounts.', group: 'overview' },
  { id: 'commands', label: 'Commands', summary: 'Default and custom commands for Discord, Kick and Twitch, with variables.', group: 'overview' },
  { id: 'giveaways', label: 'Giveaways', summary: 'One giveaway runs at a time. Viewers enter with !enter in Kick or Twitch chat, or the Enter Giveaway button on Discord.', group: 'overview' },
  { id: 'timed-messages', label: 'Timed Messages', summary: 'Messages repeated in Kick or Twitch chat or a Discord channel — every X minutes, after X chat messages, or both.', group: 'overview' },
  // The id is kept from when this page was "Discord Moderation", so remembered pages keep working.
  { id: 'discord-moderation', label: 'Discord Bot', summary: 'Your Discord bot: settings, protection and logs.', group: 'discord' },
  { id: 'sticky-messages', label: 'Sticky Messages', summary: 'Messages kept at the bottom of Discord channels.', group: 'discord' },
  { id: 'embed-creator', label: 'Embed Creator', summary: 'Build Discord messages with embeds (visually or as JSON), send them as your bot and edit them later.', group: 'discord' },
  { id: 'loyalty', label: 'Loyalty & Rewards', summary: 'Discord XP, levels and role rewards, plus a separate points balance, rewards and redemptions.', group: 'discord' },
  { id: 'kick-moderation', label: 'Kick Moderation', summary: 'Automated protection for your Kick chat, and its logs.', group: 'kick' },
  { id: 'kick-notifications', label: 'Kick Notifications', summary: 'Discord posts when Kick streamers — yours or anyone’s — go live.', group: 'kick' },
  { id: 'kick-clips', label: 'Clips', summary: 'Your channel’s Kick clips: posted in Discord with watch buttons, and saved on this PC.', group: 'kick' },
  { id: 'twitch-notifications', label: 'Twitch Notifications', summary: 'Discord posts when Twitch streamers — yours or anyone’s — go live.', group: 'twitch' },
  { id: 'twitch-moderation', label: 'Twitch Moderation', summary: 'Automated protection and chat modes for your Twitch chat, and its logs.', group: 'twitch' },
  { id: 'overlays', label: 'OBS Overlays', summary: 'Browser-source overlays secured with scoped access tokens.', group: 'planned', soon: true },
  { id: 'settings', label: 'Settings', summary: 'This copy of CONDUIT: version, system status, appearance, backups, logs and release notes.', group: 'footer' },
];
