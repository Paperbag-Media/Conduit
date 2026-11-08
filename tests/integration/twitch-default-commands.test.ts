/**
 * Twitch default commands (1.4.0) against a simulated Twitch (automated, mocked — not proof that real Twitch works):
 * answers, permissions, the shared cooldown, switching them off, custom commands taking their place, and an account
 * connected before these commands asked for more permissions.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandsHubState, CustomCommandView, TwitchSetupState } from '@conduit/shared';
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
const friend = user(4, 'coolstreamer');
const MOD = { badges: [{ set_id: 'moderator' }] };

type Res<T> = { status: number; body: T & { error?: { code: string; message: string; issues?: Array<{ path: string; message: string }> } } };
const call = <T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => h.call<T>(method, path, body === undefined ? {} : { body }) as Promise<Res<T>>;
const state = async () => (await call<TwitchSetupState>('GET', '/api/twitch/setup')).body;
const hub = async () => (await call<CommandsHubState>('GET', '/api/commands/twitch')).body;

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`never matched: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function connect(): Promise<void> {
  const res = await call<{ authorizationUrl: string }>('POST', '/api/connections/twitch/connect', { role: 'primary' });
  expect((await fetch(twitch.approve(new URL(res.body.authorizationUrl), streamer))).status).toBe(200);
}

/** Someone types in chat; resolves with the chatbot's reply. */
async function say(from: FakeTwitchUser, text: string, opts: Parameters<FakeTwitch['chat']>[3] = {}): Promise<string> {
  const before = twitch.sentChat.length;
  twitch.chat(streamer, from, text, opts);
  await until(() => twitch.sentChat, (x) => x.length > before);
  return twitch.sentChat.at(-1)!.message;
}

/** Long enough for the message to have been handled, for checks that nothing was posted. */
const settled = () => new Promise((r) => setTimeout(r, 100));

beforeEach(async () => {
  twitch = new FakeTwitch();
  for (const u of [streamer, viewer, mod, friend]) twitch.directory.set(u.login, u);
  const eventSub = await twitch.startEventSub();
  h = await createHarness({}, { vault: new MemoryVault(), fetch: twitch.fetch, twitchEventSubUrl: eventSub });
  expect((await call('POST', '/api/twitch/application', { clientId: TWITCH_CLIENT_ID, clientSecret: TWITCH_CLIENT_SECRET })).status).toBe(200);
  await connect();
  await h.services.twitchChat.start();
  await until(state, (s) => s.chat.receive.status === 'connected');
});
afterEach(async () => {
  await h.close();
  await twitch.stopEventSub();
});

describe('answers', () => {
  it('!uptime and !title use your stream; !title shows the title while offline too', async () => {
    twitch.channels.set(streamer.login, { title: 'Offline title', game_name: 'Just Chatting' });
    expect(await say(viewer, '!uptime')).toBe('Retrolive is offline right now.');
    expect(await say(mod, '!title', MOD)).toBe('Title: Offline title');
    twitch.live.set(streamer.login, { started_at: new Date(Date.now() - 2 * 3_600_000).toISOString(), title: 'Live title' });
    expect(await say(mod, '!title', MOD)).toBe('Title: Live title');
  });

  it('!followage answers for the person asking or the one named, and says who doesn’t follow', async () => {
    twitch.followers.set(viewer.id, new Date(h.clock.now().getTime() - 3 * 86_400_000).toISOString());
    expect(await say(viewer, '!followage')).toMatch(/^Viewer has followed Retrolive for 3 days/);
    expect(await say(mod, '!followage @helper', MOD)).toBe('helper isn’t following Retrolive.');
    expect(await say(mod, '!followage @nobody', MOD)).toBe('I couldn’t find a Twitch user called nobody.');
    expect(await say(mod, '!followage @retrolive', MOD)).toBe('Retrolive is the streamer!');
  });

  it('!so shouts out a channel with its link and category, live or not', async () => {
    twitch.channels.set(friend.login, { title: 'x', game_name: 'Tetris' });
    expect(await say(mod, '!so @coolstreamer', MOD)).toBe('Go check out Coolstreamer at twitch.tv/coolstreamer! They were last streaming Tetris.');
    twitch.live.set(friend.login, { started_at: new Date().toISOString(), game_name: 'Doom' });
    expect(await say(mod, '!so coolstreamer', MOD)).toBe('Go check out Coolstreamer at twitch.tv/coolstreamer! They’re live now with Doom!');
    expect(await say(mod, '!so @nobody', MOD)).toBe('I couldn’t find a Twitch channel called nobody.');
  });

  it('moderators change the title and category through the main account', async () => {
    twitch.categories.push({ id: '509658', name: 'Just Chatting' }, { id: '1', name: 'Just Dance' });
    expect(await say(mod, '!title New stream title', MOD)).toBe('Title changed to: New stream title');
    expect(await say(mod, '!setcategory just chatting', MOD)).toBe('Category changed to Just Chatting.');
    expect(twitch.channelUpdates).toEqual([
      { broadcasterId: streamer.id, title: 'New stream title' },
      { broadcasterId: streamer.id, game_id: '509658' },
    ]);
    expect(await say(mod, '!setcategory unknown game', MOD)).toBe('I couldn’t find a category called unknown game.');
  });

  it('!addcom, !editcom and !delcom manage Twitch custom commands; !commands lists what everyone can use', async () => {
    expect(await say(mod, '!addcom !discord Join us', MOD)).toBe('Added !discord.');
    expect((await call<CustomCommandView[]>('GET', '/api/commands/twitch')).body).toMatchObject({ custom: [{ trigger: '!discord', response: 'Join us' }] });
    expect(await say(viewer, '!commands')).toBe('Commands: !enter, !commands, !uptime, !followage, !discord');
    expect(await say(mod, '!editcom !discord New invite', MOD)).toBe('Updated !discord.');
    expect(await say(viewer, '!discord')).toBe('New invite');
    expect(await say(mod, '!delcom !discord', MOD)).toBe('Deleted !discord.');
    expect((await hub()).custom).toEqual([]);
  });
});

describe('rules', () => {
  it('viewers can’t use moderator commands, and that is shown as blocked (nothing in chat)', async () => {
    twitch.chat(streamer, viewer, '!title Hacked');
    await until(hub, (s) => s.recent.some((r) => r.trigger === '!title' && r.outcome === 'blocked'));
    expect(twitch.sentChat).toEqual([]);
    expect(twitch.channelUpdates).toEqual([]);
  });

  it('everyone’s commands share a short cooldown; moderators skip it', async () => {
    await say(viewer, '!uptime');
    twitch.chat(streamer, viewer, '!uptime');
    await until(hub, (s) => s.recent.some((r) => r.trigger === '!uptime' && r.outcome === 'blocked'));
    expect(twitch.sentChat).toHaveLength(1);
    await say(mod, '!uptime', MOD);
    expect(twitch.sentChat).toHaveLength(2);
  });

  it('a command switched off stays quiet; a custom command with its trigger answers instead', async () => {
    const off = await call<CommandsHubState>('POST', '/api/twitch/default-commands', { disabled: ['!uptime'] });
    expect(off.body.defaults.find((d) => d.trigger === '!uptime')?.enabled).toBe(false);
    twitch.chat(streamer, viewer, '!uptime');
    await settled();
    expect(twitch.sentChat).toEqual([]);

    expect((await call('POST', '/api/commands/twitch', { trigger: '!followage', response: 'Mine answers' })).status).toBe(201);
    expect((await hub()).defaults.find((d) => d.trigger === '!followage')?.inactiveReason).toBe('Your custom !followage answers instead');
    expect(await say(viewer, '!followage')).toBe('Mine answers');
  });

  it('refuses triggers that aren’t Twitch default commands', async () => {
    const res = await call('POST', '/api/twitch/default-commands', { disabled: ['!clip'] });
    expect(res.status).toBe(400);
    expect(res.body.error?.issues?.[0]?.message).toBe('!clip isn’t a Twitch default command');
  });
});

describe('an account connected before 1.4.0', () => {
  beforeEach(() => {
    h.db.prepare(`UPDATE platform_connections SET granted_scopes = '["user:read:chat","user:write:chat"]' WHERE platform = 'twitch'`).run();
  });

  it('keeps working, and the commands that need more say to reconnect', async () => {
    const defaults = (await hub()).defaults;
    expect(defaults.find((d) => d.trigger === '!followage')?.inactiveReason).toBe('Reconnect your main Twitch account to use this');
    expect(defaults.find((d) => d.trigger === '!setcategory')?.inactiveReason).toBe('Reconnect your main Twitch account to use this');
    expect(defaults.find((d) => d.trigger === '!uptime')?.inactiveReason).toBeNull();

    expect(await say(viewer, '!followage')).toMatch(/^I can’t check that yet: reconnect the main Twitch account/);
    expect(await say(mod, '!title New', MOD)).toMatch(/^I can’t change the stream yet: reconnect the main Twitch account/);
    expect(twitch.channelUpdates).toEqual([]);
  });

  it('reconnecting grants them', async () => {
    await connect();
    await until(state, (s) => s.chat.receive.status === 'connected');
    expect((await hub()).defaults.find((d) => d.trigger === '!followage')?.inactiveReason).toBeNull();
  });
});
