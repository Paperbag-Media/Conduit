/**
 * Twitch giveaways (1.5.0) against a simulated Twitch (automated, mocked — not proof that real Twitch works): entering
 * with !enter in Twitch chat, who can't enter, subscriber tickets, and the messages the chatbot posts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandsHubState, GiveawaysState, GiveawayView, TwitchSetupState } from '@conduit/shared';
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
const fan = user(3, 'fan');

type Res<T> = { status: number; body: T & { error?: { code: string; message: string; issues?: Array<{ path: string; message: string }> } } };
const call = <T>(method: 'GET' | 'POST', path: string, body?: unknown) => h.call<T>(method, path, body === undefined ? {} : { body }) as Promise<Res<T>>;
const state = async () => (await call<TwitchSetupState>('GET', '/api/twitch/setup')).body;
const giveaways = async () => (await call<GiveawaysState>('GET', '/api/giveaways')).body;
const start = (body: Record<string, unknown> = {}) => call<GiveawayView>('POST', '/api/giveaways', { prize: 'Steam gift card', platforms: ['twitch'], ...body });
const current = async (id: string) => (await giveaways()).giveaways.find((g) => g.id === id)!;
const posted = () => twitch.sentChat.map((m) => m.message);

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

beforeEach(async () => {
  twitch = new FakeTwitch();
  for (const u of [streamer, viewer, fan]) twitch.directory.set(u.login, u);
  const eventSub = await twitch.startEventSub();
  h = await createHarness({}, { vault: new MemoryVault(), fetch: twitch.fetch, twitchEventSubUrl: eventSub });
  expect((await call('POST', '/api/twitch/application', { clientId: TWITCH_CLIENT_ID, clientSecret: TWITCH_CLIENT_SECRET })).status).toBe(200);
});
afterEach(async () => {
  await h.close();
  await twitch.stopEventSub();
});

async function liveChat(): Promise<void> {
  await connect();
  await h.services.twitchChat.start();
  await until(state, (s) => s.chat.receive.status === 'connected');
}

describe('starting', () => {
  it('needs the main Twitch account, and says what entry needs', async () => {
    const res = await start();
    expect(res.status).toBe(400);
    expect(res.body.error?.message).toMatch(/connect your main Twitch account/);
    expect((await giveaways()).entry.twitch).toMatchObject({ command: '!enter', ready: false, note: expect.stringMatching(/Twitch chat to be connected/) });
    await liveChat();
    expect((await giveaways()).entry.twitch).toEqual({ command: '!enter', ready: true, note: null });
  });

  it('announces in Twitch chat with how to enter', async () => {
    await liveChat();
    const res = await start();
    expect(res.status).toBe(201);
    expect(res.body.platforms).toEqual(['twitch']);
    expect(posted()[0]).toContain('To enter, type !enter in chat.');
    expect((await current(res.body.id)).announcement).toMatchObject({ kind: 'started', outcome: 'sent' });
  });
});

describe('entering', () => {
  beforeEach(liveChat);

  it('!enter adds a viewer once and confirms it in chat; the streamer and other giveaways’ platforms can’t', async () => {
    const { body: g } = await start();
    twitch.chat(streamer, viewer, '!enter');
    await until(posted, (x) => x.includes('Viewer has entered the giveaway!'));
    twitch.chat(streamer, viewer, '!ENTER again');
    twitch.chat(streamer, streamer, '!enter');
    await until(() => current(g.id), (x) => x.entriesByPlatform.twitch === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect((await current(g.id)).entryCount).toBe(1);
    expect(posted().filter((m) => m.includes('has entered'))).toHaveLength(1);
  });

  it('a Discord-only giveaway ignores !enter in Twitch chat', async () => {
    const g = h.services.giveaways.create({ prize: 'Discord prize', platforms: ['discord'] });
    twitch.chat(streamer, viewer, '!enter');
    await new Promise((r) => setTimeout(r, 100));
    expect((await current(g.id)).entryCount).toBe(0);
  });

  it('Twitch subscribers and founders get the multiplier, from the badge on their !enter', async () => {
    const { body: g } = await start({ subscriberMultiplier: 3 });
    twitch.chat(streamer, viewer, '!enter', { badges: [{ set_id: 'subscriber', info: '4' }] });
    twitch.chat(streamer, fan, '!enter');
    const after = await until(() => current(g.id), (x) => x.entriesByPlatform.twitch === 2);
    expect(after).toMatchObject({ verifiedSubscribers: 1, ticketCount: 4 });
  });

  it('after closing, !enter gets one short answer', async () => {
    const { body: g } = await start();
    await call('POST', `/api/giveaways/${g.id}/end`);
    await until(posted, (x) => x.some((m) => m.startsWith('Entries for Steam gift card are now closed')));
    twitch.chat(streamer, viewer, '!enter');
    twitch.chat(streamer, fan, '!enter');
    await until(posted, (x) => x.includes('Giveaway entries are closed.'));
    await new Promise((r) => setTimeout(r, 100));
    expect(posted().filter((m) => m === 'Giveaway entries are closed.')).toHaveLength(1);
    expect((await current(g.id)).entryCount).toBe(0);
  });
});

describe('drawing', () => {
  beforeEach(liveChat);

  it('announces a Twitch winner as @name in Twitch chat', async () => {
    const { body: g } = await start();
    twitch.chat(streamer, viewer, '!enter');
    await until(() => current(g.id), (x) => x.entryCount === 1);
    const drawn = await call<GiveawayView>('POST', `/api/giveaways/${g.id}/draw`);
    expect(drawn.body.winners[0]).toMatchObject({ platform: 'twitch', platformUserId: viewer.id, displayName: 'Viewer' });
    await until(posted, (x) => x.some((m) => m.includes('Winner of Steam gift card: @Viewer.')));
  });
});

describe('Commands → Twitch', () => {
  beforeEach(liveChat);

  it('lists !enter, always on, and custom commands can’t take it', async () => {
    const hub = (await call<CommandsHubState>('GET', '/api/commands/twitch')).body;
    expect(hub.defaults[0]).toMatchObject({ trigger: '!enter', enabled: true, canDisable: false });
    expect((await call('POST', '/api/commands/twitch', { trigger: '!enter', response: 'mine' })).status).toBe(400);
  });
});
