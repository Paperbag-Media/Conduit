/**
 * Automated protection for one platform's chat, one instance each for Kick and Twitch: blocked words/phrases, links,
 * caps, emotes, symbols, long messages, repeated messages and message flooding, each with its own action (log only,
 * delete the message, or time out), plus raid mode. It's off by default and every rule starts as "log only". Each chat
 * event is checked once (by message id), the channel owner, the chatbot account, moderators (optional) and CONDUIT's own
 * messages are never acted on, and actions run one at a time through a bounded queue.
 *
 * What differs per platform comes in as a ChatProtectionTarget; every action still goes through ModerationService, so
 * it is recorded the same way as any other.
 */
import crypto from 'node:crypto';
import { settingsRepo, type ChattersRepo, type Database, type ModerationRecord } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  automodMatcher,
  automodSettingsSchema,
  chatTextCheck,
  disallowedLinks,
  type AutomodAction,
  type AutomodMatcher,
  type AutomodRecordRule,
  type AutomodRule,
  type AutomodSettings,
  type ChatProtectionState,
  type ModerationCapability,
  type RaidState,
} from '@conduit/shared';
import { writeAudit } from '../audit';
import { AppError } from '../errors';
import { parseInput } from '../validation';

/** Message ids remembered so a re-delivered chat event is checked once. */
const SEEN_LIMIT = 2000;
/** Users tracked for repeat/flood detection at once (oldest forgotten first). */
const TRACKED_USERS = 5000;
/** At most this many automated actions wait at once; beyond that, new ones are logged and skipped. */
const MAX_PENDING_ACTIONS = 20;
/** The same rule doesn't act on (or log) the same user again within this window. */
const RULE_COOLDOWN_MS = 30_000;
/** Raid mode starts working once CONDUIT has seen chat this long, and this many different chatters. */
const RAID_LEARNING_MS = 2 * 60 * 60_000;
const RAID_LEARNING_CHATTERS = 25;

/** What a check (or raid mode) matched, and what to do. */
interface ChatMatch {
  rule: AutomodRecordRule;
  action: AutomodAction;
  timeoutMinutes: number;
  detail: string;
}

/** The settings key of each check. */
const RULE_KEY = {
  blocked_terms: 'blockedTerms',
  links: 'links',
  caps: 'caps',
  emotes: 'emotes',
  symbols: 'symbols',
  long_message: 'longMessage',
  repeat: 'repeat',
  spam: 'spam',
} as const satisfies Record<AutomodRule, keyof AutomodSettings>;
const CHECK_KEYS = Object.values(RULE_KEY);

/** A chat message, as both platforms deliver it. */
export interface ProtectedMessage {
  messageId: string;
  content: string;
  /** The text for the text checks, when it differs (Twitch's emotes in Kick's form). */
  checkText?: string;
  senderUserId: string;
  senderUsername: string;
  /** What ignored users are matched against, when it isn't the name. */
  senderLogin?: string;
  broadcasterUserId: string;
  badgeTypes: readonly string[];
}

/** An automated action on a message's sender. */
export interface ProtectionAction {
  action: 'timeout' | 'delete_message';
  durationSeconds: number | null;
  reason: string;
  rule: AutomodRecordRule;
}

export interface ChatProtectionTarget {
  platform: 'kick' | 'twitch';
  label: string;
  settingKey: string;
  /** When CONDUIT started remembering who chats (raid mode learns the regulars first). */
  chattersSinceKey: string;
  chatters: ChattersRepo;
  defaults: AutomodSettings;
  /** Badges of those "Ignore moderators" skips. */
  moderatorBadges: readonly string[];
  chatbotUserId: () => string | null;
  wasRecentlySent: (text: string) => boolean;
  /** The channel and the account acting in it. */
  place: () => { id: string; name: string; account: string } | null;
  actions: () => Record<AutomodAction, ModerationCapability>;
  /** Performs an action, recording its outcome. Throws when it can't be attempted. */
  act: (m: ProtectedMessage, a: ProtectionAction) => Promise<unknown>;
  announce: (text: string) => Promise<unknown>;
}

export interface ChatProtectionOptions {
  db: Database;
  now: () => Date;
  logger: Logger;
  target: ChatProtectionTarget;
  /** Records something that wasn't an action through the moderation service: a log-only match, or one that couldn't start. */
  record: (r: ModerationRecord) => void;
}

export class ChatProtection {
  private readonly seen = new Set<string>();
  private readonly recentByUser = new Map<string, number[]>();
  private readonly repeatsByUser = new Map<string, { text: string; times: number[] }>();
  private readonly lastActed = new Map<string, number>();
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private stats = { checked: 0, matched: 0, since: '' };
  private termMatcher: { key: string; matcher: AutomodMatcher } = { key: '', matcher: automodMatcher({ keywords: [], regexPatterns: [], allowList: [] }) };
  /** Raid mode is on until then (ms; 0: off). */
  private raidUntil = 0;
  /** When recent first-time chatters were first seen (raid detection). */
  private firstTimers: number[] = [];
  /** First-time chatters who count as newcomers during raid mode, and when they were first seen. */
  private readonly raidNewcomers = new Map<string, number>();
  private readonly t: ChatProtectionTarget;

  constructor(private readonly o: ChatProtectionOptions) {
    this.t = o.target;
    this.stats.since = o.now().toISOString();
  }

  /** Waits for queued automated actions (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  settings(): AutomodSettings {
    const raw = settingsRepo.get(this.o.db, this.t.settingKey);
    if (!raw) return structuredClone(this.t.defaults);
    try {
      const parsed = automodSettingsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : structuredClone(this.t.defaults);
    } catch {
      return structuredClone(this.t.defaults);
    }
  }

  state(): ChatProtectionState {
    return { settings: this.settings(), actions: this.t.actions(), raid: this.raidState(), stats: { ...this.stats } };
  }

  /** Saves the settings. An action the main account can't perform is refused, with the reason. */
  save(raw: unknown): void {
    const settings = parseInput(automodSettingsSchema, raw);
    const caps = this.t.actions();
    const issues: Array<{ path: string; message: string }> = [];
    for (const rule of CHECK_KEYS) {
      const r = settings[rule];
      if (settings.enabled && r.enabled && !caps[r.action].available) issues.push({ path: `${rule}.action`, message: caps[r.action].problem! });
    }
    if (settings.enabled && settings.raid.enabled && !caps[settings.raid.action].available) issues.push({ path: 'raid.action', message: caps[settings.raid.action].problem! });
    if (issues.length > 0) throw new AppError('validation_error', `Some actions aren’t available on ${this.t.label}`, { issues });
    settingsRepo.set(this.o.db, this.t.settingKey, JSON.stringify(settings), this.o.now().toISOString());
    if (!settings.enabled || !settings.raid.enabled) this.raidUntil = 0;
    writeAudit(
      this.o.db,
      {
        action: 'moderation.automod_updated',
        outcome: 'success',
        actorUserId: null,
        metadata: {
          platform: this.t.platform,
          enabled: settings.enabled,
          ...Object.fromEntries(CHECK_KEYS.map((k) => [k, settings[k].enabled ? settings[k].action : 'off'])),
          raid: settings.raid.enabled ? settings.raid.action : 'off',
          terms: settings.blockedTerms.terms.length,
        },
      },
      this.o.now(),
    );
    this.o.logger.info('automod settings saved', { platform: this.t.platform, enabled: settings.enabled });
  }

  // ── raid mode ──────────────────────────────────────────────────────────────

  /** Raid mode can start once CONDUIT knows enough of your chat (so regulars aren't taken for raiders). */
  private learning(): boolean {
    const since = Date.parse(settingsRepo.get(this.o.db, this.t.chattersSinceKey) ?? '');
    return !Number.isFinite(since) || this.o.now().getTime() - since < RAID_LEARNING_MS || this.t.chatters.count(this.o.db) < RAID_LEARNING_CHATTERS;
  }

  private raidState(): RaidState {
    const now = this.o.now().getTime();
    return { activeUntil: this.raidUntil > now ? new Date(this.raidUntil).toISOString() : null, learning: this.learning(), knownChatters: this.t.chatters.count(this.o.db) };
  }

  /** Starts raid mode now (or ends it) from the dashboard. */
  setRaid(active: boolean): void {
    const s = this.settings();
    if (active) {
      if (!s.enabled || !s.raid.enabled) throw new AppError('conflict', 'Switch on Automated Protection and Raid mode first.');
      this.startRaid(s, 'started from the dashboard');
    } else {
      this.raidUntil = 0;
      this.raidNewcomers.clear();
      this.o.logger.info('raid mode ended from the dashboard', { platform: this.t.platform });
    }
  }

  private startRaid(s: AutomodSettings, why: string): void {
    const now = this.o.now().getTime();
    const wasOn = this.raidUntil > now;
    this.raidUntil = now + s.raid.durationMinutes * 60_000;
    this.o.logger.info('raid mode on', { platform: this.t.platform, why, minutes: s.raid.durationMinutes });
    if (!wasOn && s.raid.announcement) void this.t.announce(s.raid.announcement).catch(() => undefined);
  }

  /**
   * Remembers who chats. A first-time chatter (once CONDUIT knows the chat) counts toward a raid, and while raid mode
   * is on (or the raid is still recent) counts as a newcomer.
   */
  private noteChatter(m: ProtectedMessage, s: AutomodSettings): void {
    const now = this.o.now();
    if (!settingsRepo.get(this.o.db, this.t.chattersSinceKey)) settingsRepo.set(this.o.db, this.t.chattersSinceKey, now.toISOString(), now.toISOString());
    const learning = this.learning();
    const first = this.t.chatters.seen(this.o.db, m.senderUserId, m.senderUsername, now.toISOString());
    if (!first || learning || !s.enabled || !s.raid.enabled) return;
    const ms = now.getTime();
    this.track(this.raidNewcomers, m.senderUserId, ms);
    this.firstTimers = this.firstTimers.filter((t) => ms - t < s.raid.windowSeconds * 1000);
    this.firstTimers.push(ms);
    if (this.firstTimers.length >= s.raid.newChatters) {
      this.firstTimers = [];
      this.startRaid(s, `${s.raid.newChatters} first-time chatters within ${s.raid.windowSeconds} s`);
    }
  }

  /** During raid mode: a newcomer whose message has a link, or that a check matched (even a log-only one), is acted on. */
  private raidMatch(m: ProtectedMessage, s: AutomodSettings, match: ChatMatch | null): ChatMatch | null {
    const now = this.o.now().getTime();
    if (!s.raid.enabled || this.raidUntil <= now) return null;
    const since = this.raidNewcomers.get(m.senderUserId);
    if (since === undefined || now - since > s.raid.durationMinutes * 60_000) return null;
    const link = disallowedLinks(m.content, s.links.allowedSites)[0];
    if (!match && !link) return null;
    const why = match ? match.detail : `Posted a link (${link!.slice(0, 60)}).`;
    return { rule: 'raid', action: s.raid.action, timeoutMinutes: s.raid.timeoutMinutes, detail: `First-time chatter during raid mode. ${why}` };
  }

  // ── checking messages ──────────────────────────────────────────────────────

  /** A chat event from the main channel. Checked once; never throws. */
  onMessage(m: ProtectedMessage): void {
    try {
      if (this.seen.has(m.messageId)) return;
      this.seen.add(m.messageId);
      if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value!);
      // Never: the channel owner, the chatbot account, CONDUIT's own messages.
      if (m.senderUserId === m.broadcasterUserId) return;
      if (m.senderUserId === this.t.chatbotUserId()) return;
      if (this.t.wasRecentlySent(m.content)) return;
      const settings = this.settings();
      // Everyone else is remembered (raid mode learns the regulars), also while protection is off.
      this.noteChatter(m, settings);
      if (!settings.enabled) return;
      // Not checked: (optionally) moderators, and ignored users.
      if (settings.exemptModerators && m.badgeTypes.some((b) => this.t.moderatorBadges.includes(b))) return;
      if (settings.ignoredUsers.includes((m.senderLogin ?? m.senderUsername).toLowerCase())) return;
      this.stats.checked++;
      const checked = this.check(m, settings);
      const match = this.raidMatch(m, settings, checked) ?? checked;
      if (!match) return;
      this.stats.matched++;
      const key = `${match.rule}:${m.senderUserId}`;
      const nowMs = this.o.now().getTime();
      // Delete-message acts on every matching message; logging and timeouts once per user per rule per window.
      if (match.action !== 'delete_message') {
        if (nowMs - (this.lastActed.get(key) ?? 0) < RULE_COOLDOWN_MS) return;
        this.lastActed.set(key, nowMs);
        if (this.lastActed.size > TRACKED_USERS) this.lastActed.delete(this.lastActed.keys().next().value!);
      }
      this.enqueue(m, match);
    } catch (err) {
      this.o.logger.error('automod check failed', { err });
    }
  }

  private check(m: ProtectedMessage, s: AutomodSettings): ChatMatch | null {
    const nowMs = this.o.now().getTime();
    const text = normalize(m.content);
    const b = s.blockedTerms;
    if (b.enabled && (b.terms.length > 0 || b.regexPatterns.length > 0)) {
      const found = this.matcher(s).match(m.content);
      if (found) return { rule: 'blocked_terms', action: b.action, timeoutMinutes: b.timeoutMinutes, detail: `Matched a blocked word or phrase (“${found.slice(0, 60)}”).` };
    }
    const textMatch = chatTextCheck(m.checkText ?? m.content, s);
    if (textMatch) {
      const r = s[RULE_KEY[textMatch.rule]];
      return { rule: textMatch.rule, action: r.action, timeoutMinutes: r.timeoutMinutes, detail: textMatch.detail };
    }
    // Flooding: more than maxMessages within the window.
    const times = (this.recentByUser.get(m.senderUserId) ?? []).filter((t) => nowMs - t < s.spam.windowSeconds * 1000);
    times.push(nowMs);
    this.track(this.recentByUser, m.senderUserId, times);
    if (s.spam.enabled && times.length > s.spam.maxMessages) {
      this.recentByUser.delete(m.senderUserId); // start counting again
      return { rule: 'spam', action: s.spam.action, timeoutMinutes: s.spam.timeoutMinutes, detail: `More than ${s.spam.maxMessages} messages in ${s.spam.windowSeconds} seconds.` };
    }
    // Repeats: the same text `count` times within the window.
    const prev = this.repeatsByUser.get(m.senderUserId);
    const repeat = prev && prev.text === text ? prev.times.filter((t) => nowMs - t < s.repeat.windowSeconds * 1000) : [];
    repeat.push(nowMs);
    this.track(this.repeatsByUser, m.senderUserId, { text, times: repeat });
    if (s.repeat.enabled && text.length > 0 && repeat.length >= s.repeat.count) {
      this.repeatsByUser.delete(m.senderUserId);
      return { rule: 'repeat', action: s.repeat.action, timeoutMinutes: s.repeat.timeoutMinutes, detail: `The same message ${s.repeat.count} times in ${s.repeat.windowSeconds} seconds.` };
    }
    return null;
  }

  private track<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > TRACKED_USERS) map.delete(map.keys().next().value!);
  }

  /** The blocked words, patterns and allowed words, compiled once per change (Discord AutoMod's matcher). */
  private matcher(s: AutomodSettings): AutomodMatcher {
    const b = s.blockedTerms;
    const key = JSON.stringify([b.terms, b.regexPatterns, b.allowList]);
    if (this.termMatcher.key !== key) this.termMatcher = { key, matcher: automodMatcher({ keywords: b.terms, regexPatterns: b.regexPatterns, allowList: b.allowList }) };
    return this.termMatcher.matcher;
  }

  private enqueue(m: ProtectedMessage, match: ChatMatch): void {
    const place = this.t.place();
    const base = {
      id: crypto.randomUUID(),
      createdAt: this.o.now().toISOString(),
      platform: this.t.platform,
      placeId: place?.id ?? m.broadcasterUserId,
      placeName: place?.name ?? null,
      targetUserId: m.senderUserId,
      targetName: m.senderUsername,
      messageId: m.messageId,
      source: 'automod' as const,
      rule: match.rule,
    };
    if (match.action === 'log') {
      this.o.record({ ...base, action: 'flag', durationSeconds: null, reason: null, actor: null, outcome: 'logged', detail: match.detail });
      return;
    }
    if (this.pending >= MAX_PENDING_ACTIONS) {
      this.o.logger.warn('automod action skipped (busy)', { platform: this.t.platform, rule: match.rule });
      return;
    }
    this.pending++;
    const action = match.action;
    const durationSeconds = action === 'timeout' ? match.timeoutMinutes * 60 : null;
    const reason = `Automated: ${match.detail}`.slice(0, 100);
    this.queue = this.queue.then(async () => {
      try {
        await this.t.act(m, { action, durationSeconds, reason, rule: match.rule });
      } catch (err) {
        // Couldn't be attempted (e.g. the account lost its permission): recorded so it isn't silent.
        this.o.record({
          ...base,
          createdAt: this.o.now().toISOString(),
          action,
          durationSeconds,
          reason,
          actor: place?.account ?? null,
          outcome: 'failed',
          detail: err instanceof AppError ? err.message : 'The automated action couldn’t be attempted.',
        });
      } finally {
        this.pending--;
      }
    });
  }
}

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}
