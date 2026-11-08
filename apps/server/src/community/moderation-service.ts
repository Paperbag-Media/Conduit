/**
 * Moderation: actions on Discord, Kick and Twitch, the history of actions taken through CONDUIT, and automated protection
 * for Kick and Twitch chat (chat-protection.ts).
 *
 * Every action uses the connected account's own platform permissions and the platform's official API:
 * - Discord, with the bot token. What the bot may do is read from its roles in each server (Discord's permission
 *   algorithm, server level); Discord still has the final say (role hierarchy, channel overwrites), and its refusal is
 *   reported as a failure.
 * - Kick, with the main account's token (the channel owner), scopes moderation:ban and moderation:chat_message:manage.
 * - Twitch, with the main account's token (the channel owner), which also changes its chat modes and Shield Mode.
 * Nothing is reported as done until the platform confirms it. Each attempt (success or failure) is recorded in
 * moderation_actions; validation errors, disconnected platforms and missing permissions stop before anything is sent.
 */
import crypto from 'node:crypto';
import {
  discordLogEntriesRepo,
  discordModerationEventsRepo,
  discordProtectionEventsRepo,
  discordRepo,
  kickChattersRepo,
  moderationRepo,
  SETTING_KEYS,
  settingsRepo,
  twitchChattersRepo,
  type Database,
  type DiscordLogEntryRecord,
  type DiscordModerationEventRecord,
  type DiscordProtectionEventRecord,
  type ModerationRecord,
} from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  AUTOMOD_ACTIONS,
  AUTOMOD_DEFAULTS,
  TWITCH_AUTOMOD_DEFAULTS,
  TWITCH_BAN_SCOPE,
  TWITCH_CHAT_MODES_SCOPE,
  TWITCH_DELETE_SCOPE,
  TWITCH_MODERATORS_SCOPE,
  TWITCH_SHIELD_SCOPE,
  twitchChatModesSchema,
  userHistorySchema,
  DISCORD_PERMISSION_BITS,
  MODERATION_ACTIONS,
  moderationActionSchema,
  moderationLookupSchema,
  parseDiscordMessageLink,
  parseDiscordUser,
  type AutomodAction,
  type AutomodRecordRule,
  type AutomodSettings,
  type AutomodState,
  type ModerationAction,
  type ModerationActionKind,
  type ModerationCapability,
  type ModerationLookupResult,
  type ModerationRecordView,
  type ModerationState,
  type DiscordModerationState,
  type KickModerationState,
  type LoyaltyLogEntry,
  type ModerationUserHistory,
  type TwitchChatModesState,
  type TwitchModerationState,
  type DiscordServerModerationView,
  type DiscordLogEntryView,
  type ProtectionEventView,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError } from '../errors';
import { DiscordApiError, type DiscordApi, type GuildRole } from '../discord/discord-api';
import type { GuildEvent } from '../discord/discord-bot';
import type { DiscordCredentials } from '../discord/discord-credentials';
import { KickApiError } from '../kick/kick-chat-api';
import { TwitchChatApiError } from '../twitch/twitch-chat-api';
import type { TwitchBanEvent, TwitchChatService } from '../twitch/twitch-chat-service';
import { parseInput } from '../validation';
import { channelPermissions } from '../discord/discord-giveaways';
import type { KickBanEvent, KickChatService } from '../kick/kick-chat-service';
import { ChatProtection, type ProtectedMessage, type ProtectionAction } from './chat-protection';

const { KICK_MEMBERS, BAN_MEMBERS, MANAGE_MESSAGES, MODERATE_MEMBERS } = DISCORD_PERMISSION_BITS;
const GUILD_CACHE_MS = 60_000;
const HISTORY_LIMIT = 100;
/** Discord Logging entries shown in the Moderation log (messages and members are busier than moderation). */
const LOG_ENTRY_LIMIT = 200;
/** Ban event ids remembered so a re-delivered one is recorded once. */
const SEEN_LIMIT = 2000;
/** At most this many Kick moderators are remembered (oldest first out). */
const KICK_MODERATORS_MAX = 500;
/** A ban Kick or Twitch reports within this long after CONDUIT's own ban or timeout of that user is CONDUIT's echo. */
const ECHO_WINDOW_MS = 2 * 60_000;
const USER_HISTORY_LIMIT = 300;

export const KICK_SCOPES = { ban: 'moderation:ban', chat: 'moderation:chat_message:manage' } as const;

/**
 * An action's outcome. `message` is for the dashboard and logs (operator wording); `botMessage` is what the bot says in
 * Discord, in the first person, built from the same outcome — success wording only when the platform confirmed it.
 */
export type ModerationResult = { ok: boolean; message: string; botMessage?: string; record: ModerationRecordView };

export interface ModerationServiceOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  discordApi: DiscordApi;
  discordCredentials: DiscordCredentials;
  /** The bot's display name (live or verified). */
  discordBotName: () => string | null;
  /** Loyalty & Rewards history for the Moderation log (none while it isn't set up). */
  loyaltyLog?: () => Promise<LoyaltyLogEntry[]>;
  kick: Pick<
    KickChatService,
    | 'moderator'
    | 'moderationBan'
    | 'moderationUnban'
    | 'moderationDeleteMessage'
    | 'channelBySlug'
    | 'onMessage'
    | 'onBan'
    | 'banEvents'
    | 'sendResult'
    | 'state'
    | 'chatbotIdentity'
    | 'wasRecentlySent'
  >;
  twitch: Pick<
    TwitchChatService,
    | 'moderator'
    | 'moderationBan'
    | 'moderationUnban'
    | 'moderationDeleteMessage'
    | 'isModerator'
    | 'chatModes'
    | 'updateChatModes'
    | 'shieldMode'
    | 'setShieldMode'
    | 'onMessage'
    | 'onBan'
    | 'banEvents'
    | 'sendResult'
    | 'state'
    | 'chatbotIdentity'
    | 'wasRecentlySent'
  >;
  /** A Twitch login's user id (null: no such user). */
  twitchUserId: (login: string) => Promise<string | null>;
}

interface GuildAccess {
  id: string;
  name: string;
  perms: bigint | null;
  problem: string | null;
}

const ok = (): ModerationCapability => ({ available: true, problem: null });
const no = (problem: string): ModerationCapability => ({ available: false, problem });
const TWITCH_RECONNECT = 'Reconnect your main Twitch account (Dashboard → Twitch).';

/** What automated protection can do, from a platform's capabilities (logging always works). */
function protectionActions(caps: Record<ModerationActionKind | 'lookup', ModerationCapability>): Record<AutomodAction, ModerationCapability> {
  const out = {} as Record<AutomodAction, ModerationCapability>;
  for (const action of AUTOMOD_ACTIONS) out[action] = action === 'log' ? ok() : caps[action];
  return out;
}

export class ModerationService {
  private guildCache: { at: number; guilds: GuildAccess[]; problem: string | null } | null = null;
  private unsubscribers: Array<() => void> = [];
  private readonly seenBans = new Set<string>();
  /** Kick moderators known from their chat badges (loaded from the settings on first use). */
  private kickModerators: Set<string> | null = null;
  /** Twitch users CONDUIT is acting on right now (its own ban's event can arrive before Twitch's answer). */
  private readonly actingOnTwitch = new Set<string>();
  private readonly kickProtection: ChatProtection;
  private readonly twitchProtection: ChatProtection;
  private readonly actionListeners = new Set<(r: ModerationRecordView) => void>();

  /** Every recorded moderation action (after it is saved): Discord commands, automated protection. */
  onAction(listener: (r: ModerationRecordView) => void): () => void {
    this.actionListeners.add(listener);
    return () => this.actionListeners.delete(listener);
  }

  constructor(private readonly o: ModerationServiceOptions) {
    const shared = { db: o.db, now: o.now, logger: o.logger, record: (r: ModerationRecord) => this.save(r) };
    const placeOf = (me: { userId: string; name: string; channel: string } | null) => (me ? { id: me.userId, name: me.channel, account: me.name } : null);
    this.kickProtection = new ChatProtection({
      ...shared,
      target: {
        platform: 'kick',
        label: 'Kick',
        settingKey: SETTING_KEYS.automodSettings,
        chattersSinceKey: 'kick.chatters.since',
        chatters: kickChattersRepo,
        defaults: AUTOMOD_DEFAULTS,
        moderatorBadges: ['moderator', 'broadcaster'],
        chatbotUserId: () => o.kick.chatbotIdentity().userId,
        wasRecentlySent: (text) => o.kick.wasRecentlySent(text),
        place: () => placeOf(o.kick.moderator()),
        actions: () => protectionActions(this.kickCapabilities()),
        act: (m, a) => this.protectKick(m, a),
        announce: (text) => o.kick.sendResult(text),
      },
    });
    this.twitchProtection = new ChatProtection({
      ...shared,
      target: {
        platform: 'twitch',
        label: 'Twitch',
        settingKey: SETTING_KEYS.twitchAutomodSettings,
        chattersSinceKey: 'twitch.chatters.since',
        chatters: twitchChattersRepo,
        defaults: TWITCH_AUTOMOD_DEFAULTS,
        moderatorBadges: ['moderator', 'lead_moderator', 'broadcaster'],
        chatbotUserId: () => o.twitch.chatbotIdentity().userId,
        wasRecentlySent: (text) => o.twitch.wasRecentlySent(text),
        place: () => placeOf(o.twitch.moderator()),
        actions: () => protectionActions(this.twitchCapabilities()),
        act: (m, a) => this.protectTwitch(m, a),
        announce: (text) => o.twitch.sendResult(text),
      },
    });
  }

  /** Starts automated protection (listens to Kick and Twitch chat). */
  start(): void {
    if (this.unsubscribers.length > 0) return;
    this.unsubscribers = [
      this.o.kick.onMessage((m) => {
        this.noteKickModerator(m);
        this.kickProtection.onMessage(m);
      }),
      this.o.kick.onBan((b) => this.onKickBan(b)),
      this.o.twitch.onMessage((m) => this.twitchProtection.onMessage(m)),
      this.o.twitch.onBan((b) => this.onTwitchBan(b)),
    ];
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
  }

  /** Waits for queued automated actions (tests). */
  async idle(): Promise<void> {
    await Promise.all([this.kickProtection.idle(), this.twitchProtection.idle()]);
  }

  // ── state ──────────────────────────────────────────────────────────────────

  /** The Kick Moderation page: recent chat, automated protection and Kick logs. */
  kickState(): KickModerationState {
    const me = this.o.kick.moderator();
    const chat = this.o.kick.state();
    return {
      connected: me !== null,
      problem: me ? null : 'Connect your main Kick account (Dashboard → Kick) to monitor and protect Kick chat.',
      accountName: me?.name ?? null,
      channel: me?.channel ?? null,
      chat: { status: chat.receive.status, problem: chat.receive.problem },
      automod: this.automodState(),
      history: moderationRepo.list(this.o.db, HISTORY_LIMIT, 'kick').map(toView),
    };
  }

  /** The Twitch Moderation page: automated protection and Twitch logs. */
  twitchState(): TwitchModerationState {
    const me = this.o.twitch.moderator();
    const chat = this.o.twitch.state();
    return {
      connected: me !== null,
      problem: me ? null : 'Connect your main Twitch account (Dashboard → Twitch) to protect Twitch chat.',
      accountName: me?.name ?? null,
      channel: me?.channel ?? null,
      chat: { status: chat.receive.status, problem: chat.receive.problem },
      protection: this.twitchProtection.state(),
      moderationEvents: this.o.twitch.banEvents(),
      history: moderationRepo.list(this.o.db, HISTORY_LIMIT, 'twitch').map(toView),
    };
  }

  /** The Discord Bot page: automated protection (what's possible) and the moderation logs (CONDUIT's and the server's). */
  async discordModerationState(): Promise<DiscordModerationState> {
    const discord = await this.discordState();
    const names = new Map(discord.guilds.map((g) => [g.id, g.name]));
    // The bot's permissions per server, as just read by discordState().
    const access = discord.connected ? (this.guildCache?.guilds ?? []) : [];
    return {
      ...discord,
      commands: DISCORD_MODERATION_COMMANDS.map((c) => ({
        name: c.name,
        permission: c.permission,
        missingIn: access.filter((g) => g.perms === null || !has(g.perms, c.bit)).map((g) => g.id),
      })),
      automod: this.automodState().discord,
      history: moderationRepo.list(this.o.db, HISTORY_LIMIT, 'discord').map(toView),
      serverHistory: discordModerationEventsRepo.list(this.o.db, HISTORY_LIMIT).map((r) => serverView(r, names)),
      loggingHistory: discordLogEntriesRepo.list(this.o.db, LOG_ENTRY_LIMIT).map((r) => loggingView(r, names)),
      loyaltyHistory: (await this.o.loyaltyLog?.().catch(() => [])) ?? [],
      protectionHistory: discordProtectionEventsRepo.list(this.o.db, HISTORY_LIMIT).map((r) => protectionView(r, names)),
    };
  }

  /**
   * A moderation entry from a server's audit log (a ban, kick or timeout done in Discord or by another bot, or an AutoMod
   * action): kept for Discord Bot → Logs. CONDUIT's own actions (by its bot) are already recorded with the member who ran
   * the command, so they're skipped here.
   */
  recordDiscordAudit(e: Extract<GuildEvent, { type: 'audit' }>): void {
    const botUserId = discordRepo.getApplication(this.o.db)?.botUserId ?? null;
    if (e.executor && botUserId && e.executor.id === botUserId) return;
    const automod = e.action.startsWith('automod_');
    try {
      discordModerationEventsRepo.insert(this.o.db, {
        id: crypto.randomUUID(),
        entryId: e.entryId,
        createdAt: this.o.now().toISOString(),
        guildId: e.guildId,
        action: e.action,
        targetUserId: e.target?.id ?? e.targetId,
        targetName: e.target?.tag ?? null,
        executorId: automod ? null : (e.executor?.id ?? null),
        executorName: automod ? null : (e.executor?.tag ?? null),
        executorBot: !automod && (e.executor?.bot ?? false),
        reason: e.reason,
        ruleName: e.ruleName ?? null,
        channelId: e.channelId ?? null,
        until: e.until,
      });
    } catch (err) {
      this.o.logger.warn('could not record a discord audit entry', { err });
    }
  }

  async state(): Promise<ModerationState> {
    const [discord] = await Promise.all([this.discordState()]);
    const me = this.o.kick.moderator();
    return {
      discord,
      kick: {
        connected: me !== null,
        problem: me ? null : 'Connect your main Kick account (Dashboard → Kick) to moderate Kick chat.',
        accountName: me?.name ?? null,
        channel: me?.channel ?? null,
        capabilities: this.kickCapabilities(),
      },
      history: moderationRepo.list(this.o.db, HISTORY_LIMIT).map(toView),
      automod: this.automodState(),
    };
  }

  private async discordState(): Promise<ModerationState['discord']> {
    const token = await this.o.discordCredentials.botToken();
    const botUserId = discordRepo.getApplication(this.o.db)?.botUserId ?? null;
    if (!token || !botUserId)
      return { connected: false, problem: 'Set up your Discord bot first (Dashboard → Discord → Connect).', botName: null, guilds: [] };
    const access = await this.guildAccess(token, botUserId);
    return {
      connected: true,
      problem: access.problem,
      botName: this.o.discordBotName(),
      guilds: access.guilds.map((g) => ({ id: g.id, name: g.name, capabilities: discordCapabilities(g), problem: g.problem })),
    };
  }

  private async guildAccess(token: string, botUserId: string, force = false): Promise<{ guilds: GuildAccess[]; problem: string | null }> {
    const nowMs = this.o.now().getTime();
    if (!force && this.guildCache && nowMs - this.guildCache.at < GUILD_CACHE_MS) return this.guildCache;
    let list: Array<{ id: string; name: string }>;
    try {
      list = await this.o.discordApi.botGuilds(token);
    } catch (err) {
      return { guilds: [], problem: describeDiscord(err) };
    }
    const guilds: GuildAccess[] = [];
    for (const g of list.slice(0, 25)) {
      try {
        const [roles, memberRoleIds] = await Promise.all([
          this.o.discordApi.guildRoles(token, g.id),
          this.o.discordApi.guildMemberRoles(token, g.id, botUserId),
        ]);
        guilds.push({ id: g.id, name: g.name, perms: channelPermissions({ guildId: g.id, userId: botUserId, roles, memberRoleIds, overwrites: [] }), problem: null });
      } catch (err) {
        guilds.push({ id: g.id, name: g.name, perms: null, problem: describeDiscord(err) });
      }
    }
    const result = { at: nowMs, guilds, problem: list.length === 0 ? 'The bot isn’t in any server yet. Add it to your server first.' : null };
    this.guildCache = result;
    return result;
  }

  private kickCapabilities(): Record<ModerationActionKind | 'lookup', ModerationCapability> {
    const me = this.o.kick.moderator();
    const out = {} as Record<ModerationActionKind | 'lookup', ModerationCapability>;
    if (!me) {
      const missing = no('Connect your main Kick account first.');
      for (const a of [...MODERATION_ACTIONS, 'lookup'] as const) out[a] = missing;
      return out;
    }
    const reauth = (scope: string) =>
      no(`Your main Kick account hasn’t granted “${scope}”. Select Reauthorize main account (Dashboard → Kick → Manage).`);
    const ban = me.scopes.includes(KICK_SCOPES.ban) ? ok() : reauth(KICK_SCOPES.ban);
    out.timeout = ban;
    out.ban = ban;
    out.unban = ban;
    out.untimeout = no('Kick has no separate “remove timeout”: use Unban, which also ends a timeout.');
    out.delete_message = me.scopes.includes(KICK_SCOPES.chat) ? ok() : reauth(KICK_SCOPES.chat);
    out.lookup = me.scopes.includes('channel:read') ? ok() : reauth('channel:read');
    return out;
  }

  private twitchCapabilities(): Record<ModerationActionKind | 'lookup', ModerationCapability> {
    const me = this.o.twitch.moderator();
    const out = {} as Record<ModerationActionKind | 'lookup', ModerationCapability>;
    if (!me) {
      const missing = no('Connect your main Twitch account first.');
      for (const a of [...MODERATION_ACTIONS, 'lookup'] as const) out[a] = missing;
      return out;
    }
    const needs = (scope: string) => (me.scopes.includes(scope) ? ok() : no(TWITCH_RECONNECT));
    const ban = needs(TWITCH_BAN_SCOPE);
    out.timeout = ban;
    out.ban = ban;
    out.unban = ban;
    out.untimeout = no('Twitch has no separate “remove timeout”: use Unban, which also ends a timeout.');
    out.delete_message = needs(TWITCH_DELETE_SCOPE);
    out.lookup = no('Twitch users are looked up by chat commands only.');
    return out;
  }

  // ── lookup ─────────────────────────────────────────────────────────────────

  async lookup(raw: unknown): Promise<ModerationLookupResult> {
    const input = parseInput(moderationLookupSchema, raw);
    if (input.platform === 'kick') {
      const cap = this.kickCapabilities().lookup;
      if (!cap.available) throw new AppError('not_configured', cap.problem!);
      let channel: { broadcasterUserId: string; slug: string } | null;
      try {
        channel = await this.o.kick.channelBySlug(input.username.toLowerCase());
      } catch (err) {
        throw new AppError('service_unavailable', describeKick(err));
      }
      if (!channel) throw new AppError('not_found', `No Kick user named “${input.username}”.`);
      return { platform: 'kick', userId: channel.broadcasterUserId, username: channel.slug, displayName: null, inServer: null, joinedAt: null, timedOutUntil: null, roleCount: null, banned: null };
    }
    const userId = parseDiscordUser(input.user);
    if (!userId) throw invalid('user', 'Enter a Discord user ID (15–25 digits) or @mention. Turn on Developer Mode in Discord, then right-click the user → Copy User ID.');
    const { token, guild } = await this.discordGuild(input.guildId);
    try {
      const member = await this.o.discordApi.guildMember(token, guild.id, userId);
      if (member) {
        return {
          platform: 'discord',
          userId,
          username: member.username,
          displayName: member.nick ?? member.globalName,
          inServer: true,
          joinedAt: member.joinedAt,
          timedOutUntil: member.communicationDisabledUntil && Date.parse(member.communicationDisabledUntil) > this.o.now().getTime() ? member.communicationDisabledUntil : null,
          roleCount: member.roles.length,
          banned: false,
        };
      }
      const user = await this.o.discordApi.user(token, userId);
      if (!user) throw new AppError('not_found', 'No Discord user has that ID.');
      const banned = guild.perms !== null && has(guild.perms, BAN_MEMBERS) ? await this.o.discordApi.isBanned(token, guild.id, userId) : null;
      return { platform: 'discord', userId, username: user.username, displayName: user.globalName, inServer: false, joinedAt: null, timedOutUntil: null, roleCount: null, banned };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('service_unavailable', describeDiscord(err));
    }
  }

  // ── manual actions ─────────────────────────────────────────────────────────

  /** Performs one action. Resolves with the platform's outcome (recorded either way); throws before sending if it can't be attempted. */
  async act(raw: unknown): Promise<ModerationResult> {
    const a = parseInput(moderationActionSchema, raw);
    if (a.platform === 'twitch') return this.actTwitch(a, 'manual', null);
    return a.platform === 'discord' ? this.actDiscord(a) : this.actKick(a, 'manual', null);
  }

  private async actDiscord(
    a: Extract<ModerationAction, { platform: 'discord' }>,
    via?: { actor: string; resolved: ResolvedGuild },
  ): Promise<ModerationResult> {
    const link = a.action === 'delete_message' ? parseDiscordMessageLink(a.messageLink)! : null;
    const guildId = a.action === 'delete_message' ? link!.guildId : a.guildId;
    const { token, guild, botUserId } = via?.resolved ?? (await this.discordGuild(guildId));
    const targetUserId = a.action === 'delete_message' ? 'unknown' : a.userId;
    if (targetUserId === botUserId) throw invalid('userId', 'The bot can’t moderate itself.');
    const cap = discordCapabilities(guild)[a.action];
    if (!cap.available) throw new AppError('forbidden', cap.problem!);
    const actor = via?.actor ?? this.o.discordBotName() ?? 'Discord bot';
    let targetName: string | null = null;
    if (!link) {
      // A name for the history (best effort; the action itself is decided by Discord).
      targetName = await this.o.discordApi
        .guildMember(token, guild.id, targetUserId)
        .then((m) => m?.nick ?? m?.globalName ?? m?.username ?? null)
        .catch(() => null);
      // Not a member (e.g. banned): their Discord name, so replies and logs still say who it was.
      if (!targetName) {
        targetName = await this.o.discordApi
          .user(token, targetUserId)
          .then((u) => u?.globalName ?? u?.username ?? null)
          .catch(() => null);
      }
    }
    const base = {
      platform: 'discord' as const,
      placeId: guild.id,
      placeName: guild.name,
      action: a.action,
      targetUserId,
      targetName,
      messageId: link?.messageId ?? null,
      durationSeconds: a.action === 'timeout' ? a.durationSeconds : null,
      reason: a.reason,
      source: 'manual' as const,
      actor,
      rule: null,
    };
    try {
      switch (a.action) {
        case 'timeout':
          await this.o.discordApi.timeoutMember(token, guild.id, a.userId, new Date(this.o.now().getTime() + a.durationSeconds * 1000).toISOString(), a.reason);
          break;
        case 'untimeout':
          await this.o.discordApi.timeoutMember(token, guild.id, a.userId, null, a.reason);
          break;
        case 'ban':
          await this.o.discordApi.banMember(token, guild.id, a.userId, a.deleteMessageSeconds, a.reason);
          break;
        case 'unban':
          await this.o.discordApi.unbanMember(token, guild.id, a.userId, a.reason);
          break;
        case 'delete_message':
          await this.o.discordApi.deleteMessage(token, link!.channelId, link!.messageId, a.reason);
          break;
      }
    } catch (err) {
      return this.finish(base, false, describeDiscord(err, a.action), botFailureText(err, a.action, targetName ?? 'that user'));
    }
    return this.finish(base, true, successText('discord', a.action, targetName ?? targetUserId, guild.name, base.durationSeconds), botSuccessText(a.action, targetName ?? 'that user', base.durationSeconds));
  }

  private async actKick(
    a: Extract<ModerationAction, { platform: 'kick' }>,
    source: 'manual' | 'automod',
    rule: AutomodRecordRule | null,
    actor?: string,
  ): Promise<ModerationResult> {
    const me = this.o.kick.moderator();
    if (!me) throw new AppError('not_configured', 'Connect your main Kick account first (Dashboard → Kick).');
    if (a.userId === me.userId) throw invalid('userId', 'You can’t moderate your own channel account.');
    const cap = this.kickCapabilities()[a.action];
    if (!cap.available) throw new AppError('forbidden', cap.problem!);
    const base = {
      platform: 'kick' as const,
      placeId: me.userId,
      placeName: me.channel,
      action: a.action,
      targetUserId: a.userId,
      targetName: a.username,
      messageId: a.action === 'delete_message' ? a.messageId : null,
      durationSeconds: a.action === 'timeout' ? a.durationSeconds : null,
      reason: a.reason,
      source,
      actor: actor ?? me.name,
      rule,
    };
    try {
      switch (a.action) {
        case 'timeout':
          await this.o.kick.moderationBan(a.userId, Math.round(a.durationSeconds / 60), a.reason);
          break;
        case 'ban':
          await this.o.kick.moderationBan(a.userId, null, a.reason);
          break;
        case 'unban':
          await this.o.kick.moderationUnban(a.userId);
          break;
        case 'delete_message':
          await this.o.kick.moderationDeleteMessage(a.messageId);
          break;
      }
    } catch (err) {
      return this.finish(base, false, describeKick(err, a.action));
    }
    return this.finish(base, true, successText('kick', a.action, a.username, me.channel, base.durationSeconds));
  }

  private async actTwitch(
    a: Extract<ModerationAction, { platform: 'twitch' }>,
    source: 'manual' | 'automod',
    rule: AutomodRecordRule | null,
    actor?: string,
  ): Promise<ModerationResult> {
    const me = this.o.twitch.moderator();
    if (!me) throw new AppError('not_configured', 'Connect your main Twitch account first (Dashboard → Twitch).');
    if (a.userId === me.userId) throw invalid('userId', 'You can’t moderate your own channel account.');
    const cap = this.twitchCapabilities()[a.action];
    if (!cap.available) throw new AppError('forbidden', cap.problem!);
    const base = {
      platform: 'twitch' as const,
      placeId: me.userId,
      placeName: me.channel,
      action: a.action,
      targetUserId: a.userId,
      targetName: a.username,
      messageId: a.action === 'delete_message' ? a.messageId : null,
      durationSeconds: a.action === 'timeout' ? a.durationSeconds : null,
      reason: a.reason,
      source,
      actor: actor ?? me.name,
      rule,
    };
    this.actingOnTwitch.add(a.userId);
    try {
      switch (a.action) {
        case 'timeout':
          await this.o.twitch.moderationBan(a.userId, a.durationSeconds, a.reason);
          break;
        case 'ban':
          await this.o.twitch.moderationBan(a.userId, null, a.reason);
          break;
        case 'unban':
          await this.o.twitch.moderationUnban(a.userId);
          break;
        case 'delete_message':
          await this.o.twitch.moderationDeleteMessage(a.messageId);
          break;
      }
    } catch (err) {
      return this.finish(base, false, describeTwitch(err, a.action));
    } finally {
      this.actingOnTwitch.delete(a.userId);
    }
    return this.finish(base, true, successText('twitch', a.action, a.username, me.channel, base.durationSeconds));
  }

  /** What automated protection does on Kick. */
  private protectKick(m: ProtectedMessage, a: ProtectionAction): Promise<ModerationResult> {
    const username = /^[A-Za-z0-9_.-]{1,64}$/.test(m.senderUsername) ? m.senderUsername : 'user';
    const target = { platform: 'kick', userId: m.senderUserId, username, reason: a.reason } as const;
    return this.actKick(
      a.action === 'timeout' ? { ...target, action: 'timeout', durationSeconds: a.durationSeconds! } : { ...target, action: 'delete_message', messageId: m.messageId },
      'automod',
      a.rule,
    );
  }

  /** What automated protection does on Twitch. */
  private protectTwitch(m: ProtectedMessage, a: ProtectionAction): Promise<ModerationResult> {
    const target = { platform: 'twitch', userId: m.senderUserId, username: m.senderLogin ?? m.senderUsername, reason: a.reason } as const;
    return this.actTwitch(
      a.action === 'timeout' ? { ...target, action: 'timeout', durationSeconds: a.durationSeconds! } : { ...target, action: 'delete_message', messageId: m.messageId },
      'automod',
      a.rule,
    );
  }

  private finish(base: Omit<ModerationRecord, 'id' | 'createdAt' | 'outcome' | 'detail'>, success: boolean, message: string, botMessage?: string): ModerationResult {
    const record: ModerationRecord = {
      ...base,
      id: crypto.randomUUID(),
      createdAt: this.o.now().toISOString(),
      outcome: success ? 'success' : 'failed',
      detail: success ? null : message,
    };
    this.save(record);
    return { ok: success, message, ...(botMessage ? { botMessage } : {}), record: toView(record) };
  }

  private save(record: ModerationRecord): void {
    try {
      moderationRepo.insert(this.o.db, record);
      writeAudit(
        this.o.db,
        {
          action: 'moderation.action',
          outcome: record.outcome === 'failed' ? 'failure' : 'success',
          actorUserId: null,
          metadata: { platform: record.platform, action: record.action, source: record.source, rule: record.rule },
        },
        this.o.now(),
      );
    } catch (err) {
      this.o.logger.error('moderation record failed', { err });
    }
    this.o.logger.info('moderation action', { platform: record.platform, action: record.action, source: record.source, outcome: record.outcome });
    const view = toView(record);
    for (const listener of this.actionListeners) {
      try {
        listener(view);
      } catch (err) {
        this.o.logger.error('moderation listener failed', { err });
      }
    }
  }

  /** One server, read fresh: the bot must be in it; its permissions there come from its roles. */
  private async discordGuild(guildId: string): Promise<ResolvedGuild> {
    const token = await this.o.discordCredentials.botToken();
    const botUserId = discordRepo.getApplication(this.o.db)?.botUserId ?? null;
    if (!token || !botUserId) throw new AppError('not_configured', 'Set up your Discord bot first (Dashboard → Discord → Connect).');
    let list: Array<{ id: string; name: string }>;
    try {
      list = await this.o.discordApi.botGuilds(token);
    } catch (err) {
      throw new AppError('service_unavailable', describeDiscord(err));
    }
    const found = list.find((g) => g.id === guildId);
    if (!found) throw new AppError('not_found', 'The bot isn’t in that Discord server.');
    try {
      const [roles, memberRoleIds] = await Promise.all([
        this.o.discordApi.guildRoles(token, guildId),
        this.o.discordApi.guildMemberRoles(token, guildId, botUserId),
      ]);
      const perms = channelPermissions({ guildId, userId: botUserId, roles, memberRoleIds, overwrites: [] });
      return { token, botUserId, roles, guild: { id: found.id, name: found.name, perms, problem: null } };
    } catch (err) {
      throw new AppError('service_unavailable', describeDiscord(err));
    }
  }

  // ── Discord moderation commands (/timeout, /untimeout, /ban, /unban) ───────

  /**
   * Runs a moderation command used in Discord. Discord has already checked that the member has the command's
   * permission (default_member_permissions) and the dispatcher re-checked it; here CONDUIT also applies Discord's role
   * hierarchy to the member who ran it — the bot must not let a moderator act on someone ranked at or above them —
   * then performs the action through the same path as every other action, so it is recorded the same way.
   * Never throws for expected refusals: the answer is the message to show (privately) in Discord.
   */
  async runDiscordCommand(r: DiscordCommandRequest): Promise<{ ok: boolean; message: string }> {
    if (r.action === 'kick') return this.runDiscordKick(r);
    const parsed = moderationActionSchema.safeParse({
      platform: 'discord',
      action: r.action,
      guildId: r.guildId,
      userId: r.userId,
      ...(r.action === 'timeout' ? { durationSeconds: r.durationSeconds } : {}),
      ...(r.action === 'ban' ? { deleteMessageSeconds: r.deleteMessageSeconds ?? 0 } : {}),
      reason: r.reason ?? '',
    });
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Those options aren’t valid.' };
    const a = parsed.data as Extract<ModerationAction, { platform: 'discord' }>;
    try {
      if (r.userId === r.invokerId) return { ok: false, message: 'You can’t use this on yourself.' };
      let resolved: ResolvedGuild;
      try {
        resolved = await this.discordGuild(r.guildId);
      } catch (err) {
        if (err instanceof AppError) return { ok: false, message: 'I couldn’t check my permissions in this server right now. Please try again in a moment.' };
        throw err;
      }
      if (r.userId === resolved.botUserId) return { ok: false, message: 'I can’t moderate myself.' };
      const cap = discordCapabilities(resolved.guild)[a.action];
      if (!cap.available) {
        const permission = a.action === 'ban' || a.action === 'unban' ? 'Ban Members' : 'Timeout Members';
        return { ok: false, message: `I can’t do that because I don’t have the “${permission}” permission here. Ask an admin to give my role that permission.` };
      }
      if (a.action !== 'unban') {
        const refusal = await this.hierarchyRefusal(resolved, r.invokerId, r.userId);
        if (refusal) return { ok: false, message: refusal };
      }
      const result = await this.actDiscord(a, { actor: `${r.invokerName.slice(0, 60)} via /${r.command}`, resolved });
      return { ok: result.ok, message: result.botMessage ?? result.message };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, message: err.message };
      throw err;
    }
  }

  /**
   * /kick: removes a member from the server (they can rejoin with an invite). The same checks as the other commands
   * (the bot's Kick Members permission, Discord's role hierarchy for the member who ran it). Discord records it in the
   * server's audit log, which Discord Logging and the Discord moderation log read, so it isn't stored twice here.
   */
  private async runDiscordKick(r: DiscordCommandRequest): Promise<{ ok: boolean; message: string }> {
    if (r.userId === r.invokerId) return { ok: false, message: 'You can’t use this on yourself.' };
    let resolved: ResolvedGuild;
    try {
      resolved = await this.discordGuild(r.guildId);
    } catch (err) {
      if (err instanceof AppError) return { ok: false, message: 'I couldn’t check my permissions in this server right now. Please try again in a moment.' };
      throw err;
    }
    if (r.userId === resolved.botUserId) return { ok: false, message: 'I can’t moderate myself.' };
    if (resolved.guild.perms === null || !has(resolved.guild.perms, KICK_MEMBERS))
      return { ok: false, message: 'I can’t do that because I don’t have the “Kick Members” permission here. Ask an admin to give my role that permission.' };
    try {
      const refusal = await this.hierarchyRefusal(resolved, r.invokerId, r.userId);
      if (refusal) return { ok: false, message: refusal };
      const member = await this.o.discordApi.guildMember(resolved.token, resolved.guild.id, r.userId);
      if (!member) return { ok: false, message: 'That user isn’t in this server.' };
      const who = member.nick ?? member.globalName ?? member.username;
      const reason = `${r.invokerName.slice(0, 60)} via /kick${r.reason ? `: ${r.reason}` : ''}`;
      await this.o.discordApi.kickMember(resolved.token, resolved.guild.id, r.userId, reason);
      return { ok: true, message: `I’ve kicked ${who}.` };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, message: err.message };
      return { ok: false, message: `I couldn’t kick them because Discord denied the request: ${describeDiscord(err)}` };
    }
  }

  /**
   * A moderator's chat command on Kick (!timeout, !ban, !unban): looks the user up by name, then acts with the main
   * account like a manual action (recorded in the moderation history as "<moderator> via !command"). The message is
   * short, for chat; a refusal is never reported as done.
   */
  async runKickCommand(r: { actorName: string; actorId: string; command: string; action: 'timeout' | 'ban' | 'unban'; username: string; durationSeconds?: number; reason: string | null }): Promise<{ ok: boolean; message: string }> {
    const me = this.o.kick.moderator();
    if (!me) return { ok: false, message: 'The channel’s Kick account isn’t connected to CONDUIT.' };
    const cap = this.kickCapabilities()[r.action];
    if (!cap.available) return { ok: false, message: 'I can’t do that yet: reauthorize the main Kick account in CONDUIT (Dashboard → Kick → Manage).' };
    const username = r.username.replace(/^@+/, '');
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(username)) return { ok: false, message: 'That isn’t a Kick username.' };
    let channel: { broadcasterUserId: string; slug: string } | null;
    try {
      channel = await this.o.kick.channelBySlug(username.toLowerCase());
    } catch {
      return { ok: false, message: 'I couldn’t look that user up on Kick right now. Try again in a moment.' };
    }
    if (!channel) return { ok: false, message: `There’s no Kick user named ${username}.` };
    if (channel.broadcasterUserId === me.userId) return { ok: false, message: 'The channel owner can’t be moderated.' };
    // These act as the channel owner, who can reach moderators; so, like on Twitch, only the owner may do that here.
    if (r.actorId !== me.userId && this.kickModeratorIds().has(channel.broadcasterUserId)) return { ok: false, message: 'Moderators can’t be moderated from chat.' };
    const parsed = moderationActionSchema.safeParse({
      platform: 'kick',
      action: r.action,
      userId: channel.broadcasterUserId,
      username: channel.slug,
      ...(r.action === 'timeout' ? { durationSeconds: r.durationSeconds } : {}),
      reason: r.reason ?? '',
    });
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Those options aren’t valid.' };
    try {
      const result = await this.actKick(parsed.data as Extract<ModerationAction, { platform: 'kick' }>, 'manual', null, `${r.actorName.slice(0, 60)} via ${r.command}`);
      if (!result.ok) return { ok: false, message: `Kick didn’t ${r.action} ${channel.slug}.` };
      const minutes = Math.round((r.durationSeconds ?? 0) / 60);
      const done =
        r.action === 'timeout'
          ? `${channel.slug} is timed out for ${minutes} minute${minutes === 1 ? '' : 's'}.`
          : r.action === 'ban'
            ? `${channel.slug} is banned.`
            : `${channel.slug} is unbanned.`;
      return { ok: true, message: done };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, message: err.message };
      throw err;
    }
  }

  /** Kick moderators as last seen in chat (a moderator badge on their latest message). */
  private kickModeratorIds(): Set<string> {
    if (this.kickModerators) return this.kickModerators;
    let ids: unknown = [];
    try {
      ids = JSON.parse(settingsRepo.get(this.o.db, SETTING_KEYS.kickModerators) ?? '[]');
    } catch {
      // Unreadable: start again from what chat shows.
    }
    this.kickModerators = new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string').slice(0, KICK_MODERATORS_MAX) : []);
    return this.kickModerators;
  }

  /** Keeps the list of Kick moderators up to date from each message's badges; saved only when someone's role changes. */
  private noteKickModerator(m: { senderUserId: string; badgeTypes: readonly string[] }): void {
    try {
      const ids = this.kickModeratorIds();
      const moderator = m.badgeTypes.includes('moderator');
      if (moderator === ids.has(m.senderUserId)) return;
      if (moderator) {
        ids.add(m.senderUserId);
        if (ids.size > KICK_MODERATORS_MAX) ids.delete(ids.values().next().value!);
      } else ids.delete(m.senderUserId);
      settingsRepo.set(this.o.db, SETTING_KEYS.kickModerators, JSON.stringify([...ids]), this.o.now().toISOString());
    } catch (err) {
      this.o.logger.warn('kick moderator list not updated', { err });
    }
  }

  /**
   * A moderator's chat command on Twitch (!timeout, !ban, !unban), like Kick's. It acts as the channel owner, who can
   * reach moderators; a moderator can't on Twitch, so only the owner may do that here. Refused when that can't be checked.
   */
  async runTwitchCommand(r: { actorName: string; actorId: string; command: string; action: 'timeout' | 'ban' | 'unban'; username: string; durationSeconds?: number; reason: string | null }): Promise<{ ok: boolean; message: string }> {
    const me = this.o.twitch.moderator();
    if (!me) return { ok: false, message: 'The channel’s Twitch account isn’t connected to CONDUIT.' };
    if (!this.twitchCapabilities()[r.action].available || !me.scopes.includes(TWITCH_MODERATORS_SCOPE)) {
      return { ok: false, message: 'I can’t do that yet: reconnect the main Twitch account in CONDUIT (Dashboard → Twitch).' };
    }
    const login = r.username.replace(/^@+/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,25}$/.test(login)) return { ok: false, message: 'That isn’t a Twitch username.' };
    let userId: string | null;
    let moderator: boolean;
    try {
      userId = await this.o.twitchUserId(login);
      moderator = userId !== null && r.actorId !== me.userId && (await this.o.twitch.isModerator(userId));
    } catch {
      return { ok: false, message: 'I couldn’t look that user up on Twitch right now. Try again in a moment.' };
    }
    if (!userId) return { ok: false, message: `There’s no Twitch user named ${login}.` };
    if (userId === me.userId) return { ok: false, message: 'The channel owner can’t be moderated.' };
    if (moderator) return { ok: false, message: 'Moderators can’t be moderated from chat.' };
    const parsed = moderationActionSchema.safeParse({
      platform: 'twitch',
      action: r.action,
      userId,
      username: login,
      ...(r.action === 'timeout' ? { durationSeconds: r.durationSeconds } : {}),
      reason: r.reason ?? '',
    });
    if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Those options aren’t valid.' };
    try {
      const result = await this.actTwitch(parsed.data as Extract<ModerationAction, { platform: 'twitch' }>, 'manual', null, `${r.actorName.slice(0, 60)} via ${r.command}`);
      if (!result.ok) return { ok: false, message: `Twitch didn’t ${r.action === 'timeout' ? 'time out' : r.action} ${login}.` };
      const minutes = Math.round((r.durationSeconds ?? 0) / 60);
      const done =
        r.action === 'timeout'
          ? `${login} is timed out for ${minutes} minute${minutes === 1 ? '' : 's'}.`
          : r.action === 'ban'
            ? `${login} is banned.`
            : `${login} is unbanned.`;
      return { ok: true, message: done };
    } catch (err) {
      if (err instanceof AppError) return { ok: false, message: err.message };
      throw err;
    }
  }

  /** Discord's rule for moderating members, applied to the member who ran the command (the owner may act on anyone). */
  private async hierarchyRefusal(g: ResolvedGuild, invokerId: string, targetId: string): Promise<string | null> {
    const [ownerId, invoker, target] = await Promise.all([
      this.o.discordApi.guildOwner(g.token, g.guild.id),
      this.o.discordApi.guildMember(g.token, g.guild.id, invokerId),
      this.o.discordApi.guildMember(g.token, g.guild.id, targetId),
    ]).catch((err: unknown) => {
      throw new AppError('service_unavailable', describeDiscord(err));
    });
    if (targetId === ownerId) return 'The server owner can’t be moderated.';
    if (invokerId === ownerId || !target) return null; // not a member: nothing to compare (e.g. a ban by ID)
    const top = (roleIds: readonly string[]) => Math.max(0, ...roleIds.map((id) => g.roles.find((r) => r.id === id)?.position ?? 0));
    if (!invoker || top(invoker.roles) <= top(target.roles))
      return 'You can’t moderate members whose highest role is the same as or above yours.';
    return null;
  }

  // ── automated protection ───────────────────────────────────────────────────

  automodSettings(): AutomodSettings {
    return this.kickProtection.settings();
  }

  private automodState(): AutomodState {
    const { settings, actions, raid, stats } = this.kickProtection.state();
    return {
      kick: settings,
      kickActions: actions,
      raid,
      kickModerationEvents: this.o.kick.banEvents(),
      discord: {
        supported: false,
        reason: 'Discord protection is on Discord Bot → Protection: CONDUIT’s own AutoMod rules and message checks.',
      },
      stats,
    };
  }

  /** Saves the Kick settings. An action the main account can't perform is refused, with the reason. */
  saveAutomod(raw: unknown): AutomodState {
    this.kickProtection.save(raw);
    return this.automodState();
  }

  /** Starts Kick's raid mode now (or ends it) from the dashboard. */
  setRaid(active: boolean): AutomodState {
    this.kickProtection.setRaid(active);
    return this.automodState();
  }

  saveTwitchAutomod(raw: unknown): TwitchModerationState {
    this.twitchProtection.save(raw);
    return this.twitchState();
  }

  setTwitchRaid(active: boolean): TwitchModerationState {
    this.twitchProtection.setRaid(active);
    return this.twitchState();
  }

  // ── Twitch's chat modes and Shield Mode ────────────────────────────────────

  /** What Twitch says now, or why it can't be read or changed. Asks Twitch, so the page loads it once, not on every poll. */
  async twitchChatModes(): Promise<TwitchChatModesState> {
    const me = this.o.twitch.moderator();
    if (!me) return { modes: null, shieldMode: null, problem: 'Connect your main Twitch account first.' };
    if (!me.scopes.includes(TWITCH_CHAT_MODES_SCOPE) || !me.scopes.includes(TWITCH_SHIELD_SCOPE)) return { modes: null, shieldMode: null, problem: TWITCH_RECONNECT };
    try {
      const [modes, shieldMode] = await Promise.all([this.o.twitch.chatModes(), this.o.twitch.shieldMode()]);
      return { modes, shieldMode, problem: null };
    } catch (err) {
      return { modes: null, shieldMode: null, problem: describeTwitch(err) };
    }
  }

  async saveTwitchChatModes(raw: unknown): Promise<TwitchChatModesState> {
    const modes = parseInput(twitchChatModesSchema, raw);
    await this.changeTwitchChat(TWITCH_CHAT_MODES_SCOPE, () => this.o.twitch.updateChatModes(modes));
    return this.twitchChatModes();
  }

  async setTwitchShieldMode(active: boolean): Promise<TwitchChatModesState> {
    await this.changeTwitchChat(TWITCH_SHIELD_SCOPE, () => this.o.twitch.setShieldMode(active));
    return this.twitchChatModes();
  }

  private async changeTwitchChat(scope: string, change: () => Promise<unknown>): Promise<void> {
    const me = this.o.twitch.moderator();
    if (!me) throw new AppError('not_configured', 'Connect your main Twitch account first (Dashboard → Twitch).');
    if (!me.scopes.includes(scope)) throw new AppError('forbidden', TWITCH_RECONNECT);
    try {
      await change();
    } catch (err) {
      throw new AppError('service_unavailable', describeTwitch(err));
    }
    writeAudit(this.o.db, { action: 'moderation.twitch_chat_updated', outcome: 'success', actorUserId: null, metadata: { scope } }, this.o.now());
  }

  // ── moderation done on Kick itself ─────────────────────────────────────────

  /**
   * A ban or timeout from Kick's signed moderation.banned event: recorded for the Logs as done on Kick, unless it's the
   * echo of one CONDUIT just did itself (already recorded, with what triggered it).
   */
  private onKickBan(b: KickBanEvent): void {
    try {
      if (this.seenBans.has(b.id)) return;
      this.seenBans.add(b.id);
      if (this.seenBans.size > SEEN_LIMIT) this.seenBans.delete(this.seenBans.values().next().value!);
      const since = new Date(this.o.now().getTime() - ECHO_WINDOW_MS).toISOString();
      if (moderationRepo.conduitActedSince(this.o.db, 'kick', b.userId, ['ban', 'timeout'], since)) return;
      const me = this.o.kick.moderator();
      const seconds = b.expiresAt ? Math.round((Date.parse(b.expiresAt) - Date.parse(b.at)) / 1000) : null;
      const timeout = seconds !== null && seconds > 0;
      this.save({
        id: crypto.randomUUID(),
        createdAt: this.o.now().toISOString(),
        platform: 'kick',
        placeId: me?.userId ?? b.broadcasterUserId,
        placeName: me?.channel ?? null,
        action: timeout ? 'timeout' : 'ban',
        targetUserId: b.userId,
        targetName: b.userName,
        messageId: null,
        durationSeconds: timeout ? Math.min(seconds, 2_419_200) : null,
        reason: b.reason,
        source: 'platform',
        actor: b.moderatorName,
        rule: null,
        outcome: 'success',
        detail: null,
      });
    } catch (err) {
      this.o.logger.error('kick ban event not recorded', { err });
    }
  }

  /**
   * A ban, timeout or unban from Twitch's channel.ban and channel.unban: recorded for the Logs as done on Twitch, unless
   * it's the echo of one CONDUIT just did itself (already recorded, with what triggered it).
   */
  private onTwitchBan(b: TwitchBanEvent): void {
    try {
      if (this.actingOnTwitch.has(b.userId)) return;
      const since = new Date(this.o.now().getTime() - ECHO_WINDOW_MS).toISOString();
      if (moderationRepo.conduitActedSince(this.o.db, 'twitch', b.userId, b.kind === 'unban' ? ['unban'] : ['ban', 'timeout'], since)) return;
      const me = this.o.twitch.moderator();
      const seconds = b.expiresAt ? Math.round((Date.parse(b.expiresAt) - Date.parse(b.at)) / 1000) : null;
      const timeout = b.kind === 'ban' && seconds !== null && seconds > 0;
      this.save({
        id: crypto.randomUUID(),
        createdAt: this.o.now().toISOString(),
        platform: 'twitch',
        placeId: me?.userId ?? b.broadcasterUserId,
        placeName: me?.channel ?? null,
        action: b.kind === 'unban' ? 'unban' : timeout ? 'timeout' : 'ban',
        targetUserId: b.userId,
        targetName: b.userName,
        messageId: null,
        durationSeconds: timeout ? Math.min(seconds, 2_419_200) : null,
        reason: b.reason,
        source: 'platform',
        actor: b.moderatorName,
        rule: null,
        outcome: 'success',
        detail: null,
      });
    } catch (err) {
      this.o.logger.error('twitch ban event not recorded', { err });
    }
  }

  // ── one user's history ─────────────────────────────────────────────────────

  /** Everything recorded for one person on one platform (Kick and Twitch: protection and moderation; Discord: the whole log). */
  async userHistory(raw: unknown): Promise<ModerationUserHistory> {
    const { platform, userId } = parseInput(userHistorySchema, raw);
    const history = moderationRepo.listForUser(this.o.db, platform, userId, USER_HISTORY_LIMIT).map(toView);
    if (platform !== 'discord') return { platform, userId, history, serverHistory: [], protectionHistory: [], loggingHistory: [] };
    const discord = await this.discordState();
    const names = new Map(discord.guilds.map((g) => [g.id, g.name]));
    return {
      platform,
      userId,
      history,
      serverHistory: discordModerationEventsRepo.listForUser(this.o.db, userId, USER_HISTORY_LIMIT).map((r) => serverView(r, names)),
      protectionHistory: discordProtectionEventsRepo.listForUser(this.o.db, userId, USER_HISTORY_LIMIT).map((r) => protectionView(r, names)),
      loggingHistory: discordLogEntriesRepo.listForUser(this.o.db, userId, USER_HISTORY_LIMIT).map((r) => loggingView(r, names)),
    };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

interface ResolvedGuild {
  token: string;
  botUserId: string;
  guild: GuildAccess;
  roles: GuildRole[];
}

/** A moderation command used in Discord (from the command handler). */
export interface DiscordCommandRequest {
  guildId: string;
  invokerId: string;
  invokerName: string;
  command: string;
  action: 'timeout' | 'untimeout' | 'ban' | 'unban' | 'kick';
  userId: string;
  durationSeconds?: number;
  deleteMessageSeconds?: number;
  reason: string | null;
}

const MANAGE_CHANNELS = 1n << 4n;
const MANAGE_ROLES = 1n << 28n;

/**
 * The Discord moderation commands and the permission the bot needs to carry each out (shown on the Discord Moderation
 * page). /lock and /unlock change the channel's @everyone permissions, which takes Manage Roles.
 */
export const DISCORD_MODERATION_COMMANDS: ReadonlyArray<{ name: string; permission: string; bit: bigint }> = [
  { name: 'timeout', permission: 'Timeout Members', bit: MODERATE_MEMBERS },
  { name: 'untimeout', permission: 'Timeout Members', bit: MODERATE_MEMBERS },
  { name: 'kick', permission: 'Kick Members', bit: KICK_MEMBERS },
  { name: 'ban', permission: 'Ban Members', bit: BAN_MEMBERS },
  { name: 'unban', permission: 'Ban Members', bit: BAN_MEMBERS },
  { name: 'slowmode', permission: 'Manage Channels', bit: MANAGE_CHANNELS },
  { name: 'lock', permission: 'Manage Roles', bit: MANAGE_ROLES },
  { name: 'unlock', permission: 'Manage Roles', bit: MANAGE_ROLES },
];

function has(perms: bigint, bit: bigint): boolean {
  return (perms & bit) === bit;
}

function discordCapabilities(g: GuildAccess): Record<ModerationActionKind | 'lookup', ModerationCapability> {
  if (g.perms === null) {
    const n = no(g.problem ?? 'The bot’s permissions in this server couldn’t be read.');
    return { timeout: n, untimeout: n, ban: n, unban: n, delete_message: n, lookup: n };
  }
  const need = (bit: bigint, name: string) =>
    has(g.perms!, bit) ? ok() : no(`The bot needs the “${name}” permission in ${g.name}. Give the bot’s role this permission (Server Settings → Roles).`);
  const moderate = need(MODERATE_MEMBERS, 'Timeout Members');
  const ban = need(BAN_MEMBERS, 'Ban Members');
  return { timeout: moderate, untimeout: moderate, ban, unban: ban, delete_message: need(MANAGE_MESSAGES, 'Manage Messages'), lookup: ok() };
}

function invalid(path: string, message: string): AppError {
  return new AppError('validation_error', message, { issues: [{ path, message }] });
}

function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `${seconds} seconds`;
}

function successText(platform: 'discord' | 'kick' | 'twitch', action: ModerationActionKind, who: string, place: string, duration: number | null): string {
  const where = platform === 'discord' ? `in ${place} (Discord)` : `in ${place}’s ${platform === 'kick' ? 'Kick' : 'Twitch'} chat`;
  switch (action) {
    case 'timeout':
      return `${who} is timed out for ${formatDuration(duration ?? 0)} ${where}.`;
    case 'untimeout':
      return `${who}’s timeout was removed ${where}.`;
    case 'ban':
      return `${who} is banned ${where}.`;
    case 'unban':
      return `${who} is unbanned ${where}.`;
    case 'delete_message':
      return `The message was deleted ${where}.`;
  }
}

const BOT_VERB: Record<ModerationActionKind, string> = {
  timeout: 'time out',
  untimeout: 'remove the timeout for',
  ban: 'ban',
  unban: 'unban',
  delete_message: 'delete the message from',
};

/** What the bot says in Discord after the platform confirmed the action. */
function botSuccessText(action: ModerationActionKind, who: string, duration: number | null): string {
  switch (action) {
    case 'timeout':
      return `I’ve timed out ${who} for ${formatDuration(duration ?? 0)}.`;
    case 'untimeout':
      return `I’ve removed ${who}’s timeout.`;
    case 'ban':
      return `I’ve banned ${who}.`;
    case 'unban':
      return `I’ve unbanned ${who}.`;
    case 'delete_message':
      return 'I’ve deleted the message.';
  }
}

/** What the bot says in Discord when the platform refused: the action it couldn't do, and why, in plain words. */
function botFailureText(err: unknown, action: ModerationActionKind, who: string): string {
  const couldnt = `I couldn’t ${BOT_VERB[action]} ${who}`;
  if (!(err instanceof DiscordApiError)) return `${couldnt}. Something went wrong; please try again.`;
  switch (err.discordCode) {
    case 50013:
      return `${couldnt} because Discord denied the request: my role has to be above theirs and I need the right permission. The server owner can’t be moderated.`;
    case 50001:
      return `${couldnt} because Discord denied the request: I can’t access this server or channel.`;
    case 10007:
      return `${couldnt} because they aren’t a member of this server.`;
    case 10013:
      return `${couldnt} because there’s no Discord user with that ID.`;
    case 10026:
      return `${couldnt} because they aren’t banned.`;
  }
  switch (err.kind) {
    case 'invalid_credentials':
      return `${couldnt} because Discord rejected my login. I need to be set up again.`;
    case 'rate_limited':
      return `${couldnt} because Discord asked me to slow down. Try again${err.retryAfterSeconds ? ` in ${err.retryAfterSeconds} seconds` : ' shortly'}.`;
    case 'network':
      return `${couldnt} because I couldn’t reach Discord. Try again in a moment.`;
    case 'not_found':
      return action === 'unban' ? `${couldnt} because they aren’t banned.` : `${couldnt} because Discord couldn’t find them.`;
    case 'server_error':
      return `${couldnt} because Discord had a problem. Try again in a moment.`;
    default:
      return `${couldnt} because Discord denied the request.`;
  }
}

function describeDiscord(err: unknown, action?: ModerationActionKind): string {
  if (err instanceof DiscordApiError) {
    switch (err.discordCode) {
      case 50013:
        return 'Discord refused: the bot is missing a permission, or the member’s highest role is at or above the bot’s role (move the bot’s role higher in Server Settings → Roles). The server owner can’t be moderated.';
      case 50001:
        return 'Discord refused: the bot can’t access that channel or server.';
      case 10007:
        return 'That user isn’t a member of the server.';
      case 10013:
        return 'No Discord user has that ID.';
      case 10026:
        return 'That user isn’t banned.';
      case 10008:
        return 'That message no longer exists.';
      case 10003:
        return 'That channel no longer exists.';
      case 10004:
        return 'The bot is no longer in that server.';
    }
    if (err.kind === 'invalid_credentials') return 'Discord rejected the bot token. Set up Discord again (Dashboard → Discord).';
    if (err.kind === 'rate_limited') return `Discord asked to slow down. Try again${err.retryAfterSeconds ? ` in ${err.retryAfterSeconds} seconds` : ' shortly'}.`;
    if (err.kind === 'network') return 'Couldn’t reach Discord. Check your internet connection and try again.';
    if (err.kind === 'not_found') return action === 'unban' ? 'That user isn’t banned.' : 'Discord couldn’t find that user, message or server.';
    if (err.kind === 'forbidden') return 'Discord refused the action (missing permission or role hierarchy).';
    if (err.kind === 'server_error') return 'Discord had a problem. Try again in a moment.';
    return 'Discord rejected the request.';
  }
  return 'The action couldn’t be completed.';
}

function describeKick(err: unknown, action?: ModerationActionKind): string {
  if (err instanceof KickApiError) {
    const said = /: "(.+)"$/.exec(err.message)?.[1];
    switch (err.kind) {
      case 'unauthorized':
        return 'Kick rejected the main account’s authorization. Reconnect it (Dashboard → Kick → Manage).';
      case 'forbidden':
        return `Kick refused${said ? `: “${said}”` : ''}. The main account needs moderation permission in this channel; select Reauthorize main account if you connected it before moderation was added.`;
      case 'not_found':
        return action === 'delete_message' ? 'Kick couldn’t find that message (it may already be deleted).' : `Kick couldn’t find that user${said ? `: “${said}”` : ''}.`;
      case 'bad_request':
        return `Kick rejected the request${said ? `: “${said}”` : ''}.`;
      case 'rate_limited':
        return `Kick asked to slow down. Try again${err.retryAfterSeconds ? ` in ${err.retryAfterSeconds} seconds` : ' shortly'}.`;
      case 'network':
        return 'Couldn’t reach Kick. Check your internet connection and try again.';
      case 'server_error':
        return 'Kick had a problem. Try again in a moment.';
      default:
        return 'Kick returned an unexpected response.';
    }
  }
  return 'The action couldn’t be completed.';
}

function describeTwitch(err: unknown, action?: ModerationActionKind): string {
  if (err instanceof TwitchChatApiError) {
    const said = /HTTP \d+: (.+)\)$/.exec(err.message)?.[1];
    switch (err.kind) {
      case 'unauthorized':
        return 'Twitch rejected the main account’s authorization. Reconnect it (Dashboard → Twitch).';
      case 'forbidden':
        return `Twitch refused${said ? `: “${said}”` : ''}. Reconnect your main Twitch account if you connected it before moderation was added.`;
      case 'not_found':
        return action === 'delete_message' ? 'Twitch couldn’t find that message (it may already be deleted, or be over 6 hours old).' : `Twitch couldn’t find that${said ? `: “${said}”` : ''}.`;
      case 'bad_request':
        return `Twitch rejected the request${said ? `: “${said}”` : ''}.`;
      case 'conflict':
        return 'Someone else is acting on that user right now. Try again in a moment.';
      case 'rate_limited':
        return `Twitch asked to slow down. Try again${err.retryAfterSeconds ? ` in ${err.retryAfterSeconds} seconds` : ' shortly'}.`;
      case 'network':
        return 'Couldn’t reach Twitch. Check your internet connection and try again.';
      case 'server_error':
        return 'Twitch had a problem. Try again in a moment.';
      default:
        return 'Twitch returned an unexpected response.';
    }
  }
  return 'The action couldn’t be completed.';
}

/** A server's audit-log moderation entry, as the Moderation log shows it. */
function serverView(r: DiscordModerationEventRecord, names: Map<string, string>): DiscordServerModerationView {
  return {
    id: r.id,
    at: r.createdAt,
    place: names.get(r.guildId) ?? null,
    action: r.action,
    targetUserId: r.targetUserId,
    targetName: r.targetName,
    via: r.action.startsWith('automod_') ? 'automod' : r.executorBot ? 'bot' : 'discord',
    by: r.executorName,
    reason: r.reason,
    ruleName: r.ruleName,
    until: r.until,
  };
}

function protectionView(r: DiscordProtectionEventRecord, names: Map<string, string>): ProtectionEventView {
  return {
    id: r.id,
    at: r.createdAt,
    place: names.get(r.guildId) ?? null,
    feature: r.feature,
    rule: r.rule,
    userId: r.userId,
    userName: r.userName,
    action: r.action,
    outcome: r.outcome,
    detail: r.detail,
  };
}

function loggingView(r: DiscordLogEntryRecord, names: Map<string, string>): DiscordLogEntryView {
  return {
    id: r.id,
    at: r.createdAt,
    place: names.get(r.guildId) ?? null,
    category: r.category,
    event: r.event,
    title: r.title,
    userId: r.userId,
    userName: r.userName,
    detail: r.detail,
    posted: r.posted,
  };
}

function toView(r: ModerationRecord): ModerationRecordView {
  return {
    id: r.id,
    at: r.createdAt,
    platform: r.platform,
    place: r.placeName,
    action: r.action,
    targetUserId: r.targetUserId,
    targetName: r.targetName,
    durationSeconds: r.durationSeconds,
    reason: r.reason,
    source: r.source,
    actor: r.actor,
    rule: r.rule,
    outcome: r.outcome,
    detail: r.detail,
  };
}
