/**
 * Twitch default commands: built into CONDUIT and answered by the chatbot, like Kick's (see kick/kick-commands.ts). Each
 * can be switched off (Commands → Twitch), and a custom command with the same trigger takes its place while it exists.
 *
 * Two need permissions on your main Twitch account: !followage needs "moderator:read:followers", and changing the title
 * (!title with text) or the category (!setcategory) needs "channel:manage:broadcast". Reconnecting the account grants them.
 * !timeout, !ban and !unban need the moderation permissions below, and act with your main account.
 */
import type { ChatDefaultCommandDefinition } from '../community/custom-commands';

export const TWITCH_FOLLOWERS_SCOPE = 'moderator:read:followers';
export const TWITCH_BROADCAST_SCOPE = 'channel:manage:broadcast';
/** Bans, timeouts and unbans. */
export const TWITCH_BAN_SCOPE = 'moderator:manage:banned_users';
/** Deleting chat messages. */
export const TWITCH_DELETE_SCOPE = 'moderator:manage:chat_messages';
/** Reading who the channel's moderators are (moderators can't act on each other through the chatbot). */
export const TWITCH_MODERATORS_SCOPE = 'moderation:read';
/** Slow, followers-only, subscribers-only, emote-only and unique chat. */
export const TWITCH_CHAT_MODES_SCOPE = 'moderator:manage:chat_settings';
export const TWITCH_SHIELD_SCOPE = 'moderator:manage:shield_mode';
/** channel.ban and channel.unban: moderation done on Twitch itself, for the Logs. */
export const TWITCH_MODERATE_EVENTS_SCOPE = 'channel:moderate';

export const TWITCH_DEFAULT_COMMANDS: readonly ChatDefaultCommandDefinition[] = [
  { trigger: '!ping', message: 'Pong! I’m connected and ready!', description: 'Checks that the chatbot is connected and answering', permission: 'moderator', args: [], example: '!ping' },
  { trigger: '!commands', message: 'Commands: {commands}', description: 'Lists the commands everyone can use', permission: 'everyone', args: [], example: '!commands' },
  { trigger: '!uptime', message: '{streamer} has been live for {uptime}.', description: 'How long you’ve been live', permission: 'everyone', args: [], example: '!uptime' },
  { trigger: '!followage', message: '{user} has followed {streamer} for 1 year 2 months.', description: 'How long someone has followed you (the person asking, or the one named)', permission: 'everyone', args: ['[@name]'], example: '!followage @viewer' },
  { trigger: '!title', message: 'Title: {title}', description: 'Shows your stream title, or changes it', permission: 'moderator', args: ['[new title]'], example: '!title Chill Sunday stream' },
  { trigger: '!timeout', message: '{name} is timed out for {minutes} minutes.', description: 'Times someone out (10 minutes unless you say, up to 14 days)', permission: 'moderator', args: ['@name', '[minutes]', '[reason]'], example: '!timeout @troll 10 spamming links' },
  { trigger: '!ban', message: '{name} is banned.', description: 'Bans someone', permission: 'moderator', args: ['@name', '[reason]'], example: '!ban @troll hate speech' },
  { trigger: '!unban', message: '{name} is unbanned.', description: 'Lifts a ban or a timeout', permission: 'moderator', args: ['@name'], example: '!unban @troll' },
  { trigger: '!so', message: 'Go check out {name} at twitch.tv/{name}! They’re live now with {category}!', description: 'Shouts out another streamer, with their link and category', permission: 'moderator', args: ['@name'], example: '!so @coolstreamer' },
  { trigger: '!addcom', message: 'Added {command}.', description: 'Adds a custom command', permission: 'moderator', args: ['!name', 'reply'], example: '!addcom !discord Join us at discord.gg/retro' },
  { trigger: '!editcom', message: 'Updated {command}.', description: 'Changes a custom command’s reply', permission: 'moderator', args: ['!name', 'reply'], example: '!editcom !discord Our new invite: discord.gg/retro2' },
  { trigger: '!delcom', message: 'Deleted {command}.', description: 'Deletes a custom command', permission: 'moderator', args: ['!name'], example: '!delcom !discord' },
  { trigger: '!setcategory', message: 'Category changed to {category}.', description: 'Changes your stream category', permission: 'moderator', args: ['category'], example: '!setcategory Just Chatting' },
];
