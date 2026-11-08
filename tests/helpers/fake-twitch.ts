/**
 * A simulated Twitch (automated, mocked — not proof of live Twitch behaviour): the OAuth server at id.twitch.tv
 * (authorization code, refresh, client credentials, validate, revoke), Helix /users, /streams, /eventsub/subscriptions,
 * /chat/messages, /chat/settings and /moderation/* at api.twitch.tv, an EventSub WebSocket server on loopback (startEventSub), and profile pictures
 * on static-cdn.jtvnw.net. Shapes follow dev.twitch.tv/docs.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { FetchLike } from '../../apps/server/src/app/types';

export const TWITCH_CLIENT_ID = 'twitchclientid0000000000000001';
export const TWITCH_CLIENT_SECRET = 'twitchclientsecret00000000000001';
export const TWITCH_AVATAR_BYTES = Buffer.from('fake-twitch-avatar-png');

export interface FakeTwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
}

export interface FakeTwitchStream {
  started_at: string;
  title?: string;
  game_name?: string;
  viewer_count?: number;
  thumbnail_url?: string;
}

export class FakeTwitch {
  /** Every channel Twitch knows, by login. */
  readonly directory = new Map<string, FakeTwitchUser>();
  /** Live streams, by login. */
  readonly live = new Map<string, FakeTwitchStream>();
  /** Channel information (title, category), by login; also there while offline. */
  readonly channels = new Map<string, { title: string; game_name: string }>();
  /** When each user followed the broadcaster, by user id. */
  readonly followers = new Map<string, string>();
  /** Categories /search/categories can find. */
  readonly categories: Array<{ id: string; name: string }> = [];
  /** PATCH /channels requests Twitch accepted, in order. */
  readonly channelUpdates: Array<{ broadcasterId: string; title?: string; game_id?: string }> = [];
  private counter = 0;
  private readonly codes = new Map<string, { redirectUri: string; user: FakeTwitchUser; scopes: string[] }>();
  /** User tokens (null user: an app token). */
  readonly accessTokens = new Map<string, FakeTwitchUser | null>();
  readonly refreshTokens = new Map<string, FakeTwitchUser>();
  /** The scopes each token (access or refresh) was granted. */
  readonly tokenScopes = new Map<string, string[]>();
  /** Chat messages Twitch accepted, in order. */
  readonly sentChat: Array<{ broadcasterId: string; senderId: string; message: string }> = [];
  /** EventSub subscriptions created on WebSocket sessions. */
  readonly subscriptions: Array<{ id: string; type: string; sessionId: string; broadcasterId: string; userId: string }> = [];
  /** Who is banned or timed out (`until` null: banned), by user id. */
  readonly bans = new Map<string, { until: string | null; reason: string | null }>();
  /** Message ids DELETE /moderation/chat removed. */
  readonly deletedMessages: string[] = [];
  /** The channel's moderators, by user id. */
  readonly moderators = new Set<string>();
  /** PATCH /chat/settings bodies Twitch accepted, in order. */
  readonly chatSettingsUpdates: Array<Record<string, unknown>> = [];
  readonly chatSettings: Record<string, unknown> = { slow_mode: false, slow_mode_wait_time: null, follower_mode: false, follower_mode_duration: null, subscriber_mode: false, emote_mode: false, unique_chat_mode: false };
  shieldMode = false;
  /** Twitch answers ban requests only after this long, so their events arrive first (ms). */
  banAnswerDelayMs = 0;
  /** The next moderation request is answered with this status (and message). */
  failNextModeration: { status: number; message: string } | null = null;
  /** The next chat send is dropped (is_sent false) with this reason. */
  dropNextChat: string | null = null;
  private wss: WebSocketServer | null = null;
  private readonly sockets = new Map<string, WebSocket>();
  readonly revoked: string[] = [];
  readonly requests: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  validations = 0;
  offline = false;

  /** The browser side: the user approves on Twitch's page, signed in as `who`. Returns the redirect back to CONDUIT. */
  approve(authorizationUrl: URL, who: FakeTwitchUser): URL {
    const p = authorizationUrl.searchParams;
    if (p.get('client_id') !== TWITCH_CLIENT_ID || p.get('response_type') !== 'code') throw new Error('bad authorization request');
    const code = `twitch-code-${++this.counter}`;
    this.codes.set(code, { redirectUri: p.get('redirect_uri')!, user: who, scopes: (p.get('scope') ?? '').split(' ').filter(Boolean) });
    const back = new URL(p.get('redirect_uri')!);
    back.searchParams.set('code', code);
    back.searchParams.set('state', p.get('state')!);
    back.searchParams.set('scope', p.get('scope') ?? '');
    return back;
  }

  /** Twitch expires or revokes a token. */
  expire(token: string): void {
    this.accessTokens.delete(token);
  }

  /** The newest access token of a user (what CONDUIT currently holds). */
  tokenOf(user: FakeTwitchUser): string | undefined {
    return [...this.accessTokens.entries()].filter(([, u]) => u?.id === user.id).at(-1)?.[0];
  }

  // ── EventSub WebSocket ──────────────────────────────────────────────────────

  /** Starts the EventSub WebSocket server on loopback; returns its URL. */
  async startEventSub(): Promise<string> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
    this.wss = wss;
    wss.on('connection', (socket) => {
      const id = `session-${++this.counter}`;
      this.sockets.set(id, socket);
      socket.on('close', () => this.sockets.delete(id));
      socket.send(this.frame('session_welcome', { session: { id, status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null, connected_at: new Date().toISOString() } }));
    });
    return `ws://127.0.0.1:${(wss.address() as { port: number }).port}/ws`;
  }

  async stopEventSub(): Promise<void> {
    for (const s of this.sockets.values()) s.terminate();
    this.sockets.clear();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    this.wss = null;
  }

  /** Open WebSocket sessions right now. */
  get sessions(): string[] {
    return [...this.sockets.keys()];
  }

  /** Twitch drops every connection (e.g. a network problem). */
  dropConnections(): void {
    for (const s of this.sockets.values()) s.terminate();
  }

  /** Someone chats in a channel: delivered to every session subscribed to it. */
  chat(
    broadcaster: FakeTwitchUser,
    from: FakeTwitchUser,
    text: string,
    opts: { badges?: Array<{ set_id: string; id?: string; info?: string }>; messageId?: string; source?: string | null; fragments?: Array<{ type: string; text: string }> } = {},
  ): string {
    const messageId = opts.messageId ?? `msg-${++this.counter}`;
    const event = {
      broadcaster_user_id: broadcaster.id,
      broadcaster_user_login: broadcaster.login,
      broadcaster_user_name: broadcaster.display_name,
      chatter_user_id: from.id,
      chatter_user_login: from.login,
      chatter_user_name: from.display_name,
      message_id: messageId,
      message: { text, fragments: opts.fragments ?? [{ type: 'text', text }] },
      color: '#9146FF',
      badges: (opts.badges ?? []).map((b) => ({ set_id: b.set_id, id: b.id ?? '1', info: b.info ?? '' })),
      message_type: 'text',
      ...(opts.source !== undefined ? { source_broadcaster_user_id: opts.source } : {}),
    };
    for (const sub of this.subscriptions.filter((s) => s.broadcasterId === broadcaster.id && s.type === 'channel.chat.message')) {
      this.sockets
        .get(sub.sessionId)
        ?.send(this.frame('notification', { subscription: { id: sub.id, type: 'channel.chat.message', version: '1', status: 'enabled' }, event }, `notif-${messageId}-${sub.id}`));
    }
    return messageId;
  }

  /** Someone bans or times out a user (`endsAt` set): channel.ban reaches the channel's subscribers. */
  banEvent(broadcaster: FakeTwitchUser, user: FakeTwitchUser, moderator: FakeTwitchUser, opts: { reason?: string; bannedAt?: string; endsAt?: string | null } = {}): void {
    const endsAt = opts.endsAt ?? null;
    this.moderationEvent('channel.ban', broadcaster, user, moderator, { reason: opts.reason ?? '', banned_at: opts.bannedAt ?? new Date().toISOString(), ends_at: endsAt, is_permanent: endsAt === null });
  }

  unbanEvent(broadcaster: FakeTwitchUser, user: FakeTwitchUser, moderator: FakeTwitchUser): void {
    this.moderationEvent('channel.unban', broadcaster, user, moderator, {});
  }

  private moderationEvent(type: string, broadcaster: FakeTwitchUser, user: FakeTwitchUser, moderator: FakeTwitchUser, extra: Record<string, unknown>): void {
    const event = {
      user_id: user.id,
      user_login: user.login,
      user_name: user.display_name,
      broadcaster_user_id: broadcaster.id,
      broadcaster_user_login: broadcaster.login,
      broadcaster_user_name: broadcaster.display_name,
      moderator_user_id: moderator.id,
      moderator_user_login: moderator.login,
      moderator_user_name: moderator.display_name,
      ...extra,
    };
    for (const sub of this.subscriptions.filter((s) => s.broadcasterId === broadcaster.id && s.type === type)) {
      this.sockets.get(sub.sessionId)?.send(this.frame('notification', { subscription: { id: sub.id, type, version: '1', status: 'enabled' }, event }));
    }
  }

  /** Twitch revokes the chat subscriptions (e.g. the user disconnected the app on twitch.tv). */
  revokeSubscriptions(status = 'authorization_revoked'): void {
    for (const sub of this.subscriptions) {
      this.sockets.get(sub.sessionId)?.send(this.frame('revocation', { subscription: { id: sub.id, type: sub.type, version: '1', status } }));
    }
    this.subscriptions.length = 0;
  }

  /** Twitch asks a session to move to a new connection (session_reconnect); its subscriptions move with it. */
  reconnect(sessionId: string): void {
    const url = `ws://127.0.0.1:${(this.wss!.address() as { port: number }).port}/ws?reconnect=${sessionId}`;
    this.wss!.once('connection', () => {
      const newId = [...this.sockets.keys()].at(-1)!;
      for (const sub of this.subscriptions) if (sub.sessionId === sessionId) sub.sessionId = newId;
    });
    this.sockets.get(sessionId)?.send(this.frame('session_reconnect', { session: { id: sessionId, status: 'reconnecting', keepalive_timeout_seconds: null, reconnect_url: url } }));
  }

  private frame(type: string, payload: unknown, id = `frame-${++this.counter}`): string {
    return JSON.stringify({ metadata: { message_id: id, message_type: type, message_timestamp: new Date().toISOString() }, payload });
  }

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    this.requests.push({ url: url.toString(), method, headers });
    if (this.offline) throw new TypeError('fetch failed');
    const body = typeof init?.body === 'string' ? new URLSearchParams(init.body) : new URLSearchParams();
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    if (url.hostname === 'static-cdn.jtvnw.net') return new Response(TWITCH_AVATAR_BYTES, { status: 200, headers: { 'content-type': 'image/png' } });

    if (url.hostname === 'id.twitch.tv') {
      if (url.pathname === '/oauth2/token' && method === 'POST') {
        if (body.get('client_id') !== TWITCH_CLIENT_ID) return json(400, { status: 400, message: 'invalid client' });
        if (body.get('client_secret') !== TWITCH_CLIENT_SECRET) return json(403, { status: 403, message: 'invalid client secret' });
        const grant = body.get('grant_type');
        if (grant === 'client_credentials') {
          const token = `twitch-app-${++this.counter}`;
          this.accessTokens.set(token, null);
          return json(200, { access_token: token, expires_in: 5_000_000, token_type: 'bearer' });
        }
        let user: FakeTwitchUser | undefined;
        let granted: string[] | null = null;
        if (grant === 'authorization_code') {
          const c = this.codes.get(body.get('code') ?? '');
          if (!c || c.redirectUri !== body.get('redirect_uri')) return json(400, { status: 400, message: 'Invalid authorization code' });
          this.codes.delete(body.get('code')!);
          user = c.user;
          granted = c.scopes;
        } else if (grant === 'refresh_token') {
          user = this.refreshTokens.get(body.get('refresh_token') ?? '');
          if (!user) return json(400, { status: 400, message: 'Invalid refresh token' });
          this.refreshTokens.delete(body.get('refresh_token')!);
        } else return json(400, { status: 400, message: 'unsupported grant' });
        const scopes = granted ?? this.tokenScopes.get(body.get('refresh_token') ?? '') ?? [];
        const access = `twitch-access-${++this.counter}`;
        const refresh = `twitch-refresh-${this.counter}`;
        this.accessTokens.set(access, user);
        this.refreshTokens.set(refresh, user);
        this.tokenScopes.set(access, scopes);
        this.tokenScopes.set(refresh, scopes);
        // Twitch lists the granted scopes, and leaves `scope` out when none were requested.
        return json(200, { access_token: access, refresh_token: refresh, expires_in: 14_000, token_type: 'bearer', ...(scopes.length ? { scope: scopes } : {}) });
      }
      if (url.pathname === '/oauth2/validate') {
        this.validations++;
        const token = headers.authorization?.replace(/^OAuth /, '') ?? '';
        const user = this.accessTokens.get(token);
        if (!user) return json(401, { status: 401, message: 'invalid access token' });
        return json(200, { client_id: TWITCH_CLIENT_ID, login: user.login, scopes: this.tokenScopes.get(token) ?? [], user_id: user.id, expires_in: 13_000 });
      }
      if (url.pathname === '/oauth2/revoke' && method === 'POST') {
        const token = body.get('token') ?? '';
        if (!this.accessTokens.has(token)) return json(400, { status: 400, message: 'Invalid token' });
        this.accessTokens.delete(token);
        this.revoked.push(token);
        return new Response(null, { status: 200 });
      }
    }

    if (url.hostname === 'api.twitch.tv' && url.pathname.startsWith('/helix/')) {
      if (headers['client-id'] !== TWITCH_CLIENT_ID) return json(401, { status: 401, message: 'Client ID and OAuth token do not match' });
      const token = headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (!this.accessTokens.has(token)) return json(401, { status: 401, message: 'Invalid OAuth token' });
      const owner = this.accessTokens.get(token);
      const scopes = this.tokenScopes.get(token) ?? [];
      const payload = (() => {
        try {
          return typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, any>) : {};
        } catch {
          return {};
        }
      })();
      if (url.pathname === '/helix/eventsub/subscriptions' && method === 'POST') {
        if (!owner) return json(400, { status: 400, message: 'websocket transports require a user access token' });
        const sessionId = payload.transport?.session_id;
        if (payload.transport?.method !== 'websocket' || !this.sockets.has(sessionId)) return json(400, { status: 400, message: 'session does not exist' });
        const authorized =
          payload.type === 'channel.chat.message'
            ? payload.condition?.user_id === owner.id && scopes.includes('user:read:chat')
            : payload.condition?.broadcaster_user_id === owner.id && scopes.includes('channel:moderate');
        if (!authorized) return json(403, { status: 403, message: 'subscription missing proper authorization' });
        const id = `sub-${++this.counter}`;
        this.subscriptions.push({ id, type: payload.type, sessionId, broadcasterId: payload.condition.broadcaster_user_id, userId: owner.id });
        return json(202, { data: [{ id, status: 'enabled', type: payload.type, version: payload.version, condition: payload.condition, transport: payload.transport }], total: 1 });
      }
      if (url.pathname === '/helix/chat/messages' && method === 'POST') {
        if (!owner || owner.id !== payload.sender_id) return json(403, { status: 403, message: 'The sender must be the user in the token' });
        if (!scopes.includes('user:write:chat')) return json(401, { status: 401, message: 'Missing scope: user:write:chat' });
        if (this.dropNextChat) {
          const reason = this.dropNextChat;
          this.dropNextChat = null;
          return json(200, { data: [{ message_id: '', is_sent: false, drop_reason: { code: 'followers_only_mode', message: reason } }] });
        }
        this.sentChat.push({ broadcasterId: payload.broadcaster_id, senderId: payload.sender_id, message: payload.message });
        const broadcaster = [...this.directory.values()].find((u) => u.id === payload.broadcaster_id);
        // Like real Twitch chat, the posted message reaches the channel's chat subscribers too.
        if (broadcaster) this.chat(broadcaster, owner, payload.message);
        return json(200, { data: [{ message_id: `sent-${this.counter}`, is_sent: true, drop_reason: null }] });
      }
      if (url.pathname.startsWith('/helix/moderation/') || url.pathname === '/helix/chat/settings') {
        const q = url.searchParams;
        const needs = (scope: string) => !owner || owner.id !== q.get('broadcaster_id') || !scopes.includes(scope);
        const asModerator = (scope: string) => needs(scope) || q.get('moderator_id') !== owner?.id;
        const missing = json(401, { status: 401, message: 'Missing scope' });
        const reading = url.pathname === '/helix/chat/settings' && method === 'GET';
        if (!reading && this.failNextModeration) {
          const { status, message } = this.failNextModeration;
          this.failNextModeration = null;
          return json(status, { status, message });
        }
        if (url.pathname === '/helix/moderation/bans' && method === 'POST') {
          if (asModerator('moderator:manage:banned_users')) return missing;
          const { user_id: userId, duration, reason } = (payload.data ?? {}) as { user_id?: string; duration?: number; reason?: string };
          if (!userId) return json(400, { status: 400, message: 'user_id is required' });
          if (duration !== undefined && (duration < 1 || duration > 1_209_600)) return json(400, { status: 400, message: 'The value in the duration field is not valid' });
          if (this.bans.get(userId)?.until === null) return json(400, { status: 400, message: 'The user specified in the user_id field is already banned.' });
          const until = duration === undefined ? null : new Date(Date.now() + duration * 1000).toISOString();
          this.bans.set(userId, { until, reason: reason ?? null });
          const user = [...this.directory.values()].find((u) => u.id === userId);
          // Like real Twitch, CONDUIT's own ban comes back as an event too.
          if (user) this.banEvent(owner!, user, owner!, { ...(reason ? { reason } : {}), endsAt: until });
          if (this.banAnswerDelayMs) await new Promise((r) => setTimeout(r, this.banAnswerDelayMs));
          return json(200, { data: [{ broadcaster_id: owner!.id, moderator_id: owner!.id, user_id: userId, created_at: new Date().toISOString(), end_time: until }] });
        }
        if (url.pathname === '/helix/moderation/bans' && method === 'DELETE') {
          if (asModerator('moderator:manage:banned_users')) return missing;
          const userId = q.get('user_id') ?? '';
          if (!this.bans.delete(userId)) return json(400, { status: 400, message: 'The user specified in the user_id query parameter is not banned.' });
          const user = [...this.directory.values()].find((u) => u.id === userId);
          if (user) this.unbanEvent(owner!, user, owner!);
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/helix/moderation/chat' && method === 'DELETE') {
          if (asModerator('moderator:manage:chat_messages')) return missing;
          this.deletedMessages.push(q.get('message_id') ?? '');
          return new Response(null, { status: 204 });
        }
        if (url.pathname === '/helix/moderation/moderators') {
          if (needs('moderation:read')) return missing;
          const ids = q.getAll('user_id').filter((id) => this.moderators.has(id));
          return json(200, { data: ids.map((id) => ({ user_id: id })) });
        }
        if (url.pathname === '/helix/moderation/shield_mode') {
          if (asModerator('moderator:manage:shield_mode')) return missing;
          if (method === 'PUT') this.shieldMode = payload.is_active === true;
          return json(200, { data: [{ is_active: this.shieldMode, moderator_id: owner!.id, moderator_login: owner!.login, moderator_name: owner!.display_name, last_activated_at: '' }] });
        }
        if (reading) return json(200, { data: [{ broadcaster_id: q.get('broadcaster_id'), ...this.chatSettings }] });
        if (url.pathname === '/helix/chat/settings' && method === 'PATCH') {
          if (asModerator('moderator:manage:chat_settings')) return missing;
          // A value may only come with its mode on.
          if ((payload.slow_mode_wait_time !== undefined && payload.slow_mode !== true) || (payload.follower_mode_duration !== undefined && payload.follower_mode !== true)) {
            return json(400, { status: 400, message: 'A mode is off but its value was set' });
          }
          this.chatSettingsUpdates.push(payload);
          Object.assign(this.chatSettings, payload);
          if (payload.slow_mode === false) this.chatSettings.slow_mode_wait_time = null;
          if (payload.follower_mode === false) this.chatSettings.follower_mode_duration = null;
          return json(200, { data: [{ broadcaster_id: q.get('broadcaster_id'), ...this.chatSettings }] });
        }
      }
      if (url.pathname === '/helix/users') {
        const logins = url.searchParams.getAll('login');
        const ids = url.searchParams.getAll('id');
        if (logins.length + ids.length > 100) return json(400, { status: 400, message: 'too many' });
        let data: FakeTwitchUser[];
        if (logins.length === 0 && ids.length === 0) {
          if (!owner) return json(400, { status: 400, message: 'Missing User OAUTH Token' });
          data = [owner];
        } else data = [...this.directory.values()].filter((u) => logins.includes(u.login) || ids.includes(u.id));
        return json(200, { data });
      }
      if (url.pathname === '/helix/channels' && method === 'GET') {
        const u = [...this.directory.values()].find((x) => x.id === url.searchParams.get('broadcaster_id'));
        const c = u && this.channels.get(u.login);
        return json(200, { data: c ? [{ broadcaster_id: u.id, ...c }] : [] });
      }
      if (url.pathname === '/helix/channels' && method === 'PATCH') {
        const broadcasterId = url.searchParams.get('broadcaster_id')!;
        if (owner?.id !== broadcasterId || !scopes.includes('channel:manage:broadcast')) return json(401, { status: 401, message: 'Missing scope: channel:manage:broadcast' });
        this.channelUpdates.push({ broadcasterId, ...payload });
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/helix/channels/followers') {
        if (owner?.id !== url.searchParams.get('broadcaster_id') || !scopes.includes('moderator:read:followers')) return json(401, { status: 401, message: 'Missing scope' });
        const at = this.followers.get(url.searchParams.get('user_id') ?? '');
        return json(200, { data: at ? [{ user_id: url.searchParams.get('user_id'), followed_at: at }] : [], total: at ? 1 : 0 });
      }
      if (url.pathname === '/helix/search/categories') {
        const q = (url.searchParams.get('query') ?? '').toLowerCase();
        return json(200, { data: this.categories.filter((c) => c.name.toLowerCase().includes(q)) });
      }
      if (url.pathname === '/helix/streams') {
        const ids = url.searchParams.getAll('user_id');
        const data = [...this.directory.values()]
          .filter((u) => ids.includes(u.id) && this.live.has(u.login))
          .map((u) => {
            const s = this.live.get(u.login)!;
            return {
              id: `stream-${u.id}`,
              user_id: u.id,
              user_login: u.login,
              user_name: u.display_name,
              game_name: s.game_name ?? '',
              type: 'live',
              title: s.title ?? '',
              viewer_count: s.viewer_count ?? 0,
              started_at: s.started_at,
              thumbnail_url: s.thumbnail_url ?? `https://static-cdn.jtvnw.net/previews-ttv/live_user_${u.login}-{width}x{height}.jpg`,
            };
          });
        return json(200, { data, pagination: {} });
      }
    }
    return json(404, { status: 404, message: 'Not Found' });
  };
}
