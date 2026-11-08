/**
 * Twitch Moderation (1.6.0) against a simulated Twitch (automated, mocked — not proof that real Twitch works): automated
 * protection, !timeout/!ban/!unban, moderation done on Twitch itself, chat modes and Shield Mode, and an account connected
 * before moderation asked for more permissions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTOMOD_DEFAULTS, TWITCH_AUTOMOD_DEFAULTS, type AutomodSettings, type ModerationUserHistory, type TwitchChatModesState, type TwitchModerationState, type TwitchSetupState } from '@conduit/shared';
import { MemoryVault } from '../../apps/server/src/app/vault';
import { FakeTwitch, TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET, type FakeTwitchUser } from '../helpers/fake-twitch';
import { createHarness, type Harness } from '../helpers/harness';

let h: Harness;
let twitch: FakeTwitch;

const user = (n: number, login: string): FakeTwitchUser => ({
  id: String(9990000 + n),
  login,
  display_name: login[0]!.toUpperCase() + login.slice(1),
  profile_image_url: `https://static-cdn.jtvnw.net/jtv_user_pictures/${n}-profile_image-300x300.png`,
});
const streamer = user(1, 'retrolive');
const viewer = user(2, 'viewer');
const mod = user(3, 'helper');
const otherMod = user(4, 'seniormod');
const MOD = { badges: [{ set_id: 'moderator' }] };

type Res<T> = { status: number; body: T & { error?: { code: string; message: string; issues?: Array<{ path: string; message: string }> } } };
const call = <T>(method: 'GET' | 'POST', path: string, body?: unknown) => h.call<T>(method, path, body === undefined ? {} : { body }) as Promise<Res<T>>;
const page = async () => (await call<TwitchModerationState>('GET', '/api/moderation/twitch')).body;
const setup = async () => (await call<TwitchSetupState>('GET', '/api/twitch/setup')).body;
const saveAutomod = (s: AutomodSettings) => call<TwitchModerationState>('POST', '/api/moderation/twitch/automod', s);
const on = (patch: Partial<AutomodSettings>): AutomodSettings => ({ ...structuredClone(TWITCH_AUTOMOD_DEFAULTS), enabled: true, ...patch });
const words = (action: 'log' | 'delete_message' | 'timeout', terms = ['badword']) => ({ blockedTerms: { ...TWITCH_AUTOMOD_DEFAULTS.blockedTerms, enabled: true, terms, action, timeoutMinutes: 5 } });

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`never matched: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Long enough for the message to have been handled, for checks that nothing happened. */
const settled = async () => {
  await new Promise((r) => setTimeout(r, 100));
  await h.services.moderation.idle();
};

/** Someone types in chat; resolves once it has been checked. */
async function chat(from: FakeTwitchUser, text: string, opts: Parameters<FakeTwitch['chat']>[3] = {}): Promise<string> {
  const before = (await setup()).chat.receive.messagesReceived;
  const id = twitch.chat(streamer, from, text, opts);
  await until(setup, (s) => s.chat.receive.messagesReceived > before);
  await h.services.moderation.idle();
  return id;
}

/** Someone types a command; resolves with the chatbot's reply. */
async function say(from: FakeTwitchUser, text: string, opts: Parameters<FakeTwitch['chat']>[3] = {}): Promise<string> {
  const before = twitch.sentChat.length;
  twitch.chat(streamer, from, text, opts);
  await until(() => twitch.sentChat, (x) => x.length > before);
  return twitch.sentChat.at(-1)!.message;
}

beforeEach(async () => {
  twitch = new FakeTwitch();
  for (const u of [streamer, viewer, mod, otherMod]) twitch.directory.set(u.login, u);
  const eventSub = await twitch.startEventSub();
  h = await createHarness({}, { vault: new MemoryVault(), fetch: twitch.fetch, twitchEventSubUrl: eventSub });
  expect((await call('POST', '/api/twitch/application', { clientId: TWITCH_CLIENT_ID, clientSecret: TWITCH_CLIENT_SECRET })).status).toBe(200);
  const res = await call<{ authorizationUrl: string }>('POST', '/api/connections/twitch/connect', { role: 'primary' });
  expect((await fetch(twitch.approve(new URL(res.body.authorizationUrl), streamer))).status).toBe(200);
  await h.services.twitchChat.start();
  await until(setup, (s) => s.chat.receive.status === 'connected');
  h.services.moderation.start();
});
afterEach(async () => {
  h.services.moderation.stop();
  await h.close();
  await twitch.stopEventSub();
});

describe('automated protection', () => {
  it('is off until switched on, and links to Twitch are allowed by default', async () => {
    const s = await page();
    expect(s).toMatchObject({ connected: true, channel: 'retrolive', moderationEvents: { ok: true, problem: null } });
    expect(s.protection.settings).toMatchObject({ enabled: false, links: { allowedSites: ['twitch.tv'] } });
    await chat(viewer, 'badword');
    expect((await page()).history).toEqual([]);
    expect((await page()).protection.stats.checked).toBe(0);
  });

  it('logs only, deletes the message, or times out, with what matched', async () => {
    expect((await saveAutomod(on(words('log')))).status).toBe(200);
    await chat(viewer, 'a badword here');
    expect((await page()).history[0]).toMatchObject({ platform: 'twitch', action: 'flag', source: 'automod', rule: 'blocked_terms', outcome: 'logged', targetName: 'Viewer' });
    expect(twitch.bans.size + twitch.deletedMessages.length).toBe(0);

    await saveAutomod(on(words('delete_message')));
    const id = await chat(viewer, 'another badword');
    expect(twitch.deletedMessages).toEqual([id]);
    expect((await page()).history[0]).toMatchObject({ action: 'delete_message', outcome: 'success', rule: 'blocked_terms' });

    await saveAutomod(on(words('timeout')));
    await chat(mod, 'badword again');
    expect(twitch.bans.get(mod.id)).toMatchObject({ reason: expect.stringContaining('Automated: Matched a blocked word') });
    expect((await page()).history[0]).toMatchObject({ action: 'timeout', durationSeconds: 300, outcome: 'success', targetName: 'helper' });
  });

  it('never touches the channel owner, the chatbot or its own messages; moderators and ignored users on request', async () => {
    await saveAutomod(on({ ...words('delete_message'), ignoredUsers: ['otherbot'] }));
    const otherBot = user(9, 'otherbot');
    await chat(streamer, 'badword');
    await chat(mod, 'badword', MOD);
    await chat(otherMod, 'badword', { badges: [{ set_id: 'lead_moderator' }] });
    await chat(otherBot, 'badword');
    expect(twitch.deletedMessages).toEqual([]);

    await saveAutomod(on({ ...words('delete_message'), exemptModerators: false }));
    await chat(mod, 'badword', MOD);
    expect(twitch.deletedMessages).toHaveLength(1);
  });

  it('counts emotes from Twitch’s fragments, and an emote’s name is neither capitals nor text', async () => {
    const caps = { ...TWITCH_AUTOMOD_DEFAULTS.caps, enabled: true, minLetters: 5, percent: 80, action: 'delete_message' as const };
    const emotes = { ...TWITCH_AUTOMOD_DEFAULTS.emotes, enabled: true, maxEmotes: 2, action: 'delete_message' as const };
    await saveAutomod(on({ caps, emotes }));
    const emote = { type: 'emote', text: 'KEKWLOLOMEGALUL' };
    await chat(viewer, 'KEKWLOLOMEGALUL nice', { fragments: [emote, { type: 'text', text: ' nice' }] });
    expect(twitch.deletedMessages).toEqual([]);
    const many = await chat(viewer, 'a a a', { fragments: [emote, emote, emote] });
    expect(twitch.deletedMessages).toEqual([many]);
    expect((await page()).history[0]).toMatchObject({ rule: 'emotes' });
  });

  it('keeps Kick’s settings and history apart', async () => {
    await saveAutomod(on(words('log')));
    expect(h.services.moderation.automodSettings()).toEqual(AUTOMOD_DEFAULTS);
    await chat(viewer, 'badword');
    expect((await h.call<{ history: unknown[] }>('GET', '/api/moderation/kick')).body.history).toEqual([]);
  });

  it('reports a refusal as failed, with Twitch’s reason', async () => {
    await saveAutomod(on(words('delete_message')));
    twitch.failNextModeration = { status: 400, message: 'You may not delete another moderator\'s messages' };
    await chat(viewer, 'badword');
    expect((await page()).history[0]).toMatchObject({ action: 'delete_message', outcome: 'failed', detail: 'Twitch rejected the request: “You may not delete another moderator\'s messages”.' });
  });

  it('raid mode learns the regulars, starts on a burst of first-time chatters, and acts on their links', async () => {
    const raid = { enabled: true, newChatters: 3, windowSeconds: 60, durationMinutes: 5, action: 'delete_message' as const, timeoutMinutes: 5, announcement: 'Raid protection is on.' };
    const since = new Date(h.clock.now().getTime() - 3 * 3600_000).toISOString();
    h.db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES ('twitch.chatters.since', ?, 'x')").run(since);
    for (let i = 0; i < 25; i++) h.db.prepare("INSERT INTO twitch_chatters (user_id, username, first_seen_at, last_seen_at) VALUES (?, 'regular', 'x', 'x')").run(String(100 + i));
    await saveAutomod(on({ raid }));
    expect((await page()).protection.raid).toMatchObject({ activeUntil: null, learning: false, knownChatters: 25 });

    await chat(user(20, 'newbie1'), 'hi');
    await chat(user(21, 'newbie2'), 'hi');
    expect(twitch.sentChat).toEqual([]);
    await chat(user(22, 'newbie3'), 'hi');
    expect((await page()).protection.raid.activeUntil).not.toBeNull();
    expect(twitch.sentChat.at(-1)?.message).toBe('Raid protection is on.');

    const id = await chat(user(22, 'newbie3'), 'free-stuff.gg');
    expect(twitch.deletedMessages).toEqual([id]);
    expect((await call<TwitchModerationState>('POST', '/api/moderation/twitch/raid', { active: false })).body.protection.raid.activeUntil).toBeNull();
  });
});

describe('!timeout, !ban and !unban', () => {
  it('act with the main account and are recorded as "<moderator> via !command"', async () => {
    expect(await say(mod, '!timeout @viewer 5 spamming links', MOD)).toBe('viewer is timed out for 5 minutes.');
    expect(twitch.bans.get(viewer.id)).toMatchObject({ reason: 'spamming links' });
    expect(await say(mod, '!unban viewer', MOD)).toBe('viewer is unbanned.');
    expect(twitch.bans.has(viewer.id)).toBe(false);
    expect(await say(mod, '!ban viewer rude', MOD)).toBe('viewer is banned.');
    expect(twitch.bans.get(viewer.id)).toMatchObject({ until: null, reason: 'rude' });
    const history = (await page()).history;
    expect(history.map((r) => [r.action, r.actor])).toEqual([
      ['ban', 'Helper via !ban'],
      ['unban', 'Helper via !unban'],
      ['timeout', 'Helper via !timeout'],
    ]);
    expect(history[2]).toMatchObject({ source: 'manual', durationSeconds: 300, reason: 'spamming links' });
  });

  it('times out for 10 minutes unless told otherwise, up to 14 days', async () => {
    expect(await say(mod, '!timeout viewer', MOD)).toBe('viewer is timed out for 10 minutes.');
    expect(await say(mod, '!timeout viewer 20161', MOD)).toBe('Timeouts are 1 to 20160 minutes (14 days).');
  });

  it('are for moderators, and say what’s wrong', async () => {
    await chat(viewer, '!ban helper');
    expect(twitch.bans.size).toBe(0);
    expect(await say(mod, '!ban', MOD)).toBe('Who? Use: !ban @name');
    expect(await say(mod, '!ban nobody123', MOD)).toBe('There’s no Twitch user named nobody123.');
    expect(await say(mod, '!ban bad-name', MOD)).toBe('That isn’t a Twitch username.');
    expect(await say(mod, '!ban retrolive', MOD)).toBe('The channel owner can’t be moderated.');
  });

  it('a moderator can’t reach another moderator through the channel owner’s account; the owner can', async () => {
    twitch.moderators.add(otherMod.id);
    expect(await say(mod, '!ban seniormod', MOD)).toBe('Moderators can’t be moderated from chat.');
    expect(await say(mod, '!timeout seniormod 5', MOD)).toBe('Moderators can’t be moderated from chat.');
    expect(twitch.bans.size).toBe(0);
    expect(await say(streamer, '!timeout seniormod 5')).toBe('seniormod is timed out for 5 minutes.');
  });

  it('never report a refusal as done', async () => {
    await say(mod, '!ban viewer', MOD);
    expect(await say(mod, '!ban viewer', MOD)).toBe('Twitch didn’t ban viewer.');
    expect((await page()).history[0]).toMatchObject({ outcome: 'failed', detail: 'Twitch rejected the request: “The user specified in the user_id field is already banned.”.' });
  });

  it('can be switched off', async () => {
    expect((await call('POST', '/api/twitch/default-commands', { disabled: ['!ban'] })).status).toBe(200);
    await chat(mod, '!ban viewer', MOD);
    expect(twitch.bans.size).toBe(0);
  });
});

describe('moderation done on Twitch itself', () => {
  const logged = async (n: number) => until(async () => (await page()).history, (x) => x.length >= n);

  it('lands in the Logs: bans, timeouts with their length, and unbans', async () => {
    twitch.banEvent(streamer, viewer, mod, { reason: 'rude' });
    expect((await logged(1))[0]).toMatchObject({ platform: 'twitch', action: 'ban', source: 'platform', actor: 'Helper', targetName: 'Viewer', reason: 'rude', durationSeconds: null });

    const at = '2026-11-06T12:00:00.000Z';
    twitch.banEvent(streamer, viewer, mod, { bannedAt: at, endsAt: '2026-11-06T12:10:00.000Z' });
    expect((await logged(2))[0]).toMatchObject({ action: 'timeout', durationSeconds: 600, reason: null });

    twitch.unbanEvent(streamer, viewer, mod);
    expect((await logged(3))[0]).toMatchObject({ action: 'unban', source: 'platform', actor: 'Helper' });
  });

  it('doesn’t log CONDUIT’s own ban twice, whichever arrives first', async () => {
    twitch.banAnswerDelayMs = 100; // the event arrives before Twitch's answer
    await say(mod, '!ban viewer', MOD);
    await say(mod, '!unban viewer', MOD); // the event arrives after it
    await settled();
    expect((await page()).history.map((r) => [r.action, r.source])).toEqual([
      ['unban', 'manual'],
      ['ban', 'manual'],
    ]);
  });

  it('shows one person’s history', async () => {
    twitch.banEvent(streamer, viewer, mod);
    twitch.banEvent(streamer, mod, streamer);
    await logged(2);
    const r = await call<ModerationUserHistory>('POST', '/api/moderation/user-history', { platform: 'twitch', userId: viewer.id });
    expect(r.body.history.map((x) => x.targetName)).toEqual(['Viewer']);
  });
});

describe('chat modes and Shield Mode', () => {
  const modes = async () => (await call<TwitchChatModesState>('GET', '/api/moderation/twitch/chat-modes')).body;
  const off = { slowMode: false, slowSeconds: 30, followersOnly: false, followerMinutes: 0, subscribersOnly: false, emoteOnly: false, uniqueChat: false };

  it('reads what Twitch says, with the usual value for a mode that’s off', async () => {
    expect(await modes()).toEqual({ modes: off, shieldMode: false, problem: null });
    Object.assign(twitch.chatSettings, { slow_mode: true, slow_mode_wait_time: 45, follower_mode: true, follower_mode_duration: 60 });
    expect((await modes()).modes).toMatchObject({ slowMode: true, slowSeconds: 45, followersOnly: true, followerMinutes: 60 });
  });

  it('changes them on Twitch, sending a value only with its mode on', async () => {
    const on1 = await call<TwitchChatModesState>('POST', '/api/moderation/twitch/chat-modes', { ...off, slowMode: true, slowSeconds: 10, emoteOnly: true });
    expect(on1.body.modes).toMatchObject({ slowMode: true, slowSeconds: 10, emoteOnly: true });
    expect(twitch.chatSettingsUpdates.at(-1)).toEqual({ slow_mode: true, slow_mode_wait_time: 10, follower_mode: false, subscriber_mode: false, emote_mode: true, unique_chat_mode: false });
    const off1 = await call<TwitchChatModesState>('POST', '/api/moderation/twitch/chat-modes', off);
    expect(off1.status).toBe(200);
    expect(twitch.chatSettingsUpdates.at(-1)).not.toHaveProperty('slow_mode_wait_time');
  });

  it('refuses values Twitch doesn’t allow, before asking it', async () => {
    const res = await call('POST', '/api/moderation/twitch/chat-modes', { ...off, slowMode: true, slowSeconds: 2 });
    expect(res.status).toBe(400);
    expect(twitch.chatSettingsUpdates).toEqual([]);
  });

  it('switches Shield Mode', async () => {
    const res = await call<TwitchChatModesState>('POST', '/api/moderation/twitch/shield-mode', { active: true });
    expect(res.body.shieldMode).toBe(true);
    expect(twitch.shieldMode).toBe(true);
    expect((await call('POST', '/api/moderation/twitch/shield-mode', { active: 'yes' })).status).toBe(400);
  });

  it('says when Twitch refuses a change', async () => {
    twitch.failNextModeration = { status: 403, message: 'must have moderator privileges' };
    const res = await call('POST', '/api/moderation/twitch/chat-modes', off);
    expect(res.status).toBe(503);
    expect(res.body.error?.message).toContain('must have moderator privileges');
  });
});

describe('an account connected before 1.6.0', () => {
  beforeEach(async () => {
    h.db.prepare(`UPDATE platform_connections SET granted_scopes = '["user:read:chat","user:write:chat"]' WHERE platform = 'twitch'`).run();
    await h.services.twitchChat.ensure();
    await until(setup, (s) => s.chat.receive.status === 'connected');
  });

  it('keeps chat working; what needs more says to reconnect', async () => {
    const s = await page();
    expect(s.protection.actions).toMatchObject({ log: { available: true }, timeout: { available: false }, delete_message: { available: false } });
    expect(s.moderationEvents).toEqual({ ok: false, problem: 'Reconnect your main Twitch account to see moderation done on Twitch itself in the Logs.' });
    expect((await call<TwitchChatModesState>('GET', '/api/moderation/twitch/chat-modes')).body).toEqual({ modes: null, shieldMode: null, problem: 'Reconnect your main Twitch account (Dashboard → Twitch).' });
    expect(await say(mod, '!ban viewer', MOD)).toBe('I can’t do that yet: reconnect the main Twitch account in CONDUIT (Dashboard → Twitch).');
  });

  it('allows log-only protection, and refuses actions it can’t carry out', async () => {
    expect((await saveAutomod(on(words('log')))).status).toBe(200);
    const res = await saveAutomod(on(words('timeout')));
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toBe('Some actions aren’t available on Twitch');
  });
});

describe('not connected', () => {
  it('says so, and acts on nothing', async () => {
    await call('POST', '/api/connections/twitch/disconnect', { role: 'primary' });
    const s = await page();
    expect(s).toMatchObject({ connected: false, channel: null });
    expect((await call<TwitchChatModesState>('GET', '/api/moderation/twitch/chat-modes')).body.problem).toBe('Connect your main Twitch account first.');
  });
});
