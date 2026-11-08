/**
 * Kick default commands (see packages/shared/src/kick/kick-commands.ts): Kick's own answers. What every platform shares
 * is in DefaultCommandService.
 *
 * Moderator actions go through CONDUIT's existing services: moderation (recorded in the moderation history) and Kick's
 * API with the main account's token.
 */
import { SETTING_KEYS } from '@conduit/database';
import { formatDuration, KICK_DEFAULT_COMMANDS } from '@conduit/shared';
import { DefaultCommandService, type DefaultCommandContext, type DefaultCommandDeps } from '../community/default-command-service';
import type { ModerationService } from '../community/moderation-service';
import type { KickChannelInfo } from './kick-chat-api';

const DEFAULT_TIMEOUT_MINUTES = 10;

export interface KickDefaultCommandDeps extends DefaultCommandDeps {
  moderation: () => Pick<ModerationService, 'runKickCommand'>;
  /** Your channel: its name and slug, and the scopes the main account granted. */
  mainChannel: () => { name: string; slug: string | null; scopes: string[] } | null;
  /** Your stream's live status, title and category (Kick's public API, cached briefly). */
  streamInfo: () => Promise<{ live: boolean; title: string | null; category: string | null; startedAt: string | null } | null>;
  /** Another channel, for !so. */
  channelInfo: (slug: string) => Promise<KickChannelInfo | null>;
  /** When a user started following your channel (Kick's unofficial website data). */
  followingSince: (username: string) => Promise<string | null | undefined>;
  updateStreamInfo: (patch: { streamTitle?: string; categoryId?: number }) => Promise<void>;
  findCategory: (name: string) => Promise<{ id: number; name: string } | null>;
}

export class KickDefaultCommandService extends DefaultCommandService {
  constructor(private readonly o: KickDefaultCommandDeps) {
    super('kick', KICK_DEFAULT_COMMANDS, SETTING_KEYS.kickDefaultCommands, o);
  }

  protected async answer(trigger: string, ctx: DefaultCommandContext): Promise<string | null> {
    const words = ctx.args.split(/\s+/).filter(Boolean);
    const main = this.o.mainChannel();
    const streamer = main?.name ?? 'The streamer';
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
      case '!followage': {
        const who = words[0]?.replace(/^@+/, '') || ctx.user;
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(who)) return 'That isn’t a Kick username.';
        if (main?.slug && who.toLowerCase() === main.slug.toLowerCase()) return `${streamer} is the streamer!`;
        const since = await this.o.followingSince(who).catch(() => undefined);
        if (since === undefined) return 'I couldn’t check that right now.';
        if (since === null || !Number.isFinite(Date.parse(since))) return `${who} isn’t following ${streamer}.`;
        return `${who} has followed ${streamer} for ${formatDuration(this.o.now().getTime() - Date.parse(since))}.`;
      }
      case '!so': {
        const who = words[0]?.replace(/^@+/, '');
        if (!who) return 'Who should I shout out? Use: !so @name';
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(who)) return 'That isn’t a Kick username.';
        const c = await this.o.channelInfo(who.toLowerCase()).catch(() => undefined);
        if (c === undefined) return 'I couldn’t look that channel up right now.';
        if (!c) return `I couldn’t find a Kick channel called ${who}.`;
        const what = c.category ? (c.live ? ` They’re live now with ${c.category}!` : ` They were last streaming ${c.category}.`) : '';
        return `Go check out ${c.slug} at kick.com/${c.slug}!${what}`;
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
      if (minutes < 1 || minutes > 10_080) return 'Timeouts are 1 to 10080 minutes (7 days).';
    }
    const reason = rest.join(' ').slice(0, 100) || null;
    const action = trigger === '!timeout' ? 'timeout' : trigger === '!ban' ? 'ban' : 'unban';
    const r = await this.o.moderation().runKickCommand({
      actorName: ctx.user,
      actorId: ctx.userId,
      command: trigger,
      action,
      username: name,
      ...(action === 'timeout' ? { durationSeconds: minutes * 60 } : {}),
      reason: action === 'unban' ? null : reason,
    });
    return r.message;
  }

  private async setStreamInfo(trigger: string, value: string): Promise<string> {
    if (!value) return 'Use: !setcategory name';
    const main = this.o.mainChannel();
    if (!main) return 'The channel’s Kick account isn’t connected to CONDUIT.';
    if (!main.scopes.includes('channel:write')) return 'I can’t change the stream yet: reauthorize the main Kick account in CONDUIT (Dashboard → Kick → Manage).';
    try {
      if (trigger === '!title') {
        const title = value.slice(0, 140);
        await this.o.updateStreamInfo({ streamTitle: title });
        return `Title changed to: ${title}`;
      }
      const category = await this.o.findCategory(value.slice(0, 100));
      if (!category) return `I couldn’t find a category called ${value}.`;
      await this.o.updateStreamInfo({ categoryId: category.id });
      return `Category changed to ${category.name}.`;
    } catch (err) {
      this.o.logger.warn('kick stream info change failed', { err });
      return 'Kick didn’t accept that change.';
    }
  }
}
