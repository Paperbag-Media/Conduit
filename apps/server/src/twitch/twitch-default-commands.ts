/**
 * Twitch default commands (see packages/shared/src/twitch/twitch-commands.ts): Twitch's own answers. What every platform
 * shares is in DefaultCommandService.
 */
import { SETTING_KEYS } from '@conduit/database';
import { formatDuration, TWITCH_BAN_SCOPE, TWITCH_BROADCAST_SCOPE, TWITCH_DEFAULT_COMMANDS, TWITCH_FOLLOWERS_SCOPE } from '@conduit/shared';
import { DefaultCommandService, type DefaultCommandContext, type DefaultCommandDeps } from '../community/default-command-service';
import type { ModerationService } from '../community/moderation-service';

const RECONNECT = 'reconnect the main Twitch account in CONDUIT (Dashboard → Twitch)';
/** Twitch logins: letters, digits and underscores. */
const LOGIN = /^[A-Za-z0-9_]{1,25}$/;
const DEFAULT_TIMEOUT_MINUTES = 10;
/** Twitch's longest timeout: 14 days. */
const MAX_TIMEOUT_MINUTES = 20_160;
/** Which permission each command needs on the main account. */
const COMMAND_SCOPE: Record<string, string> = {
  '!followage': TWITCH_FOLLOWERS_SCOPE,
  '!setcategory': TWITCH_BROADCAST_SCOPE,
  '!timeout': TWITCH_BAN_SCOPE,
  '!ban': TWITCH_BAN_SCOPE,
  '!unban': TWITCH_BAN_SCOPE,
};

export interface TwitchDefaultCommandDeps extends DefaultCommandDeps {
  moderation: () => Pick<ModerationService, 'runTwitchCommand'>;
  /** Your channel: its name and login, and the scopes the main account granted. */
  mainChannel: () => { name: string | null; slug: string | null; scopes: string[] } | null;
  /** Your stream's live status, title and category. */
  streamInfo: () => Promise<{ live: boolean; title: string | null; category: string | null; startedAt: string | null } | null>;
  /** Another channel, for !so. */
  channelInfo: (login: string) => Promise<{ login: string; name: string; live: boolean; category: string | null } | null>;
  /** When someone followed your channel (null: they don't; undefined: no such user). */
  followedAt: (who: { userId: string } | { login: string }) => Promise<string | null | undefined>;
  updateStreamInfo: (patch: { title?: string; game_id?: string }) => Promise<void>;
  findCategory: (name: string) => Promise<{ id: string; name: string } | null>;
}

export class TwitchDefaultCommandService extends DefaultCommandService {
  constructor(private readonly o: TwitchDefaultCommandDeps) {
    super('twitch', TWITCH_DEFAULT_COMMANDS, SETTING_KEYS.twitchDefaultCommands, o);
  }

  protected override unavailable(trigger: string): string | null {
    const scope = COMMAND_SCOPE[trigger];
    const main = this.o.mainChannel();
    return scope && main && !main.scopes.includes(scope) ? 'Reconnect your main Twitch account to use this' : null;
  }

  protected async answer(trigger: string, ctx: DefaultCommandContext): Promise<string | null> {
    const words = ctx.args.split(/\s+/).filter(Boolean);
    const streamer = this.o.mainChannel()?.name ?? 'The streamer';
    switch (trigger) {
      case '!uptime': {
        const s = await this.o.streamInfo().catch(() => null);
        if (!s) return 'I couldn’t check the stream right now.';
        const since = s.startedAt ? Date.parse(s.startedAt) : NaN;
        if (!s.live) return `${streamer} is offline right now.`;
        return Number.isFinite(since) ? `${streamer} has been live for ${formatDuration(this.o.now().getTime() - since)}.` : `${streamer} is live right now.`;
      }
      case '!title': {
        // Moderators and the broadcaster only: with text it changes the title, without it shows the title.
        if (ctx.args.trim()) return this.setStreamInfo('!title', ctx.args.trim());
        const s = await this.o.streamInfo().catch(() => null);
        if (!s) return 'I couldn’t check the stream right now.';
        return s.title ? `Title: ${s.title}` : 'There’s no stream title set.';
      }
      case '!followage':
        return this.followage(words[0]?.replace(/^@+/, ''), ctx);
      case '!so': {
        const who = words[0]?.replace(/^@+/, '');
        if (!who) return 'Who should I shout out? Use: !so @name';
        if (!LOGIN.test(who)) return 'That isn’t a Twitch username.';
        const c = await this.o.channelInfo(who.toLowerCase()).catch(() => undefined);
        if (c === undefined) return 'I couldn’t look that channel up right now.';
        if (!c) return `I couldn’t find a Twitch channel called ${who}.`;
        const what = c.category ? (c.live ? ` They’re live now with ${c.category}!` : ` They were last streaming ${c.category}.`) : '';
        return `Go check out ${c.name} at twitch.tv/${c.login}!${what}`;
      }
      case '!timeout':
      case '!ban':
      case '!unban':
        return this.moderate(trigger, ctx, words);
      case '!setcategory':
        return this.setStreamInfo(trigger, ctx.args.trim());
      default:
        return null;
    }
  }

  private async moderate(trigger: string, ctx: DefaultCommandContext, words: string[]): Promise<string> {
    const name = words[0]?.replace(/^@+/, '');
    if (!name) return `Who? Use: ${trigger} @name`;
    let minutes = DEFAULT_TIMEOUT_MINUTES;
    let rest = words.slice(1);
    if (trigger === '!timeout' && rest[0] && /^\d+$/.test(rest[0])) {
      minutes = Number(rest[0]);
      rest = rest.slice(1);
      if (minutes < 1 || minutes > MAX_TIMEOUT_MINUTES) return `Timeouts are 1 to ${MAX_TIMEOUT_MINUTES} minutes (14 days).`;
    }
    const action = trigger === '!timeout' ? 'timeout' : trigger === '!ban' ? 'ban' : 'unban';
    const r = await this.o.moderation().runTwitchCommand({
      actorName: ctx.user,
      actorId: ctx.userId,
      command: trigger,
      action,
      username: name,
      ...(action === 'timeout' ? { durationSeconds: minutes * 60 } : {}),
      reason: rest.join(' ').slice(0, 100) || null,
    });
    return r.message;
  }

  private async followage(named: string | undefined, ctx: DefaultCommandContext): Promise<string> {
    const main = this.o.mainChannel();
    const streamer = main?.name ?? 'The streamer';
    if (!main?.scopes.includes(TWITCH_FOLLOWERS_SCOPE)) return `I can’t check that yet: ${RECONNECT}.`;
    if (named && !LOGIN.test(named)) return 'That isn’t a Twitch username.';
    const who = named ?? ctx.user;
    if (main.slug && who.toLowerCase() === main.slug) return `${streamer} is the streamer!`;
    let since: string | null | undefined;
    try {
      since = await this.o.followedAt(named ? { login: named.toLowerCase() } : { userId: ctx.userId });
    } catch (err) {
      this.o.logger.warn('twitch followage failed', { kind: (err as { kind?: string })?.kind ?? 'unknown' });
      return 'I couldn’t check that right now.';
    }
    if (since === undefined) return `I couldn’t find a Twitch user called ${who}.`;
    if (since === null || !Number.isFinite(Date.parse(since))) return `${who} isn’t following ${streamer}.`;
    return `${who} has followed ${streamer} for ${formatDuration(this.o.now().getTime() - Date.parse(since))}.`;
  }

  private async setStreamInfo(trigger: string, value: string): Promise<string> {
    if (!value) return 'Use: !setcategory name';
    const main = this.o.mainChannel();
    if (!main) return 'The channel’s Twitch account isn’t connected to CONDUIT.';
    if (!main.scopes.includes(TWITCH_BROADCAST_SCOPE)) return `I can’t change the stream yet: ${RECONNECT}.`;
    try {
      if (trigger === '!title') {
        const title = value.slice(0, 140);
        await this.o.updateStreamInfo({ title });
        return `Title changed to: ${title}`;
      }
      const category = await this.o.findCategory(value.slice(0, 100));
      if (!category) return `I couldn’t find a category called ${value}.`;
      await this.o.updateStreamInfo({ game_id: category.id });
      return `Category changed to ${category.name}.`;
    } catch (err) {
      this.o.logger.warn('twitch stream info change failed', { kind: (err as { kind?: string })?.kind ?? 'unknown' });
      return 'Twitch didn’t accept that change.';
    }
  }
}
