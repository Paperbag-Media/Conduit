/**
 * Twitch's Helix API for chat, called with a user access token and the app's Client-Id
 * (https://dev.twitch.tv/docs/api/reference/):
 * - POST /helix/eventsub/subscriptions: channel.chat.message v1 on CONDUIT's EventSub WebSocket session
 *   (https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage). With a WebSocket transport
 *   the token must belong to condition.user_id (the reading account) and carry user:read:chat. 202 = created.
 * - POST /helix/chat/messages: sends a message as sender_id (user:write:chat). 200 with is_sent false means Twitch
 *   dropped it (drop_reason says why, e.g. the chat is in followers-only mode); nothing was posted then.
 * - channel.ban and channel.unban v1 on the same session: bans, timeouts and unbans done on Twitch itself
 *   (channel:moderate).
 * Moderation, as the main account (the broadcaster is its own moderator_id):
 * - POST /helix/moderation/bans { data: { user_id, duration?, reason? } } bans, or times out for duration seconds (1 to
 *   1209600), and DELETE /helix/moderation/bans?user_id=… lifts either (moderator:manage:banned_users). A banned user
 *   can't be changed to a timeout without unbanning them first. 409 means someone else is acting on that user.
 * - DELETE /helix/moderation/chat?message_id=… deletes a message under 6 hours old, not the broadcaster's or another
 *   moderator's (moderator:manage:chat_messages).
 * - GET /helix/moderation/moderators?user_id=…: whether someone is a moderator (moderation:read).
 * - GET and PATCH /helix/chat/settings: the chat modes (moderator:manage:chat_settings to change them). A mode's value
 *   may only be sent with the mode on.
 * - GET and PUT /helix/moderation/shield_mode (moderator:manage:shield_mode).
 *
 * Errors name the request and quote Twitch's message; they never contain tokens or the message text.
 */
import type { TwitchChatModes } from '@conduit/shared';
import type { FetchLike } from '../app/types';
import { TWITCH_API_BASE } from './twitch';

const REQUEST_TIMEOUT_MS = 15_000;
export const CHAT_MESSAGE_EVENT = { type: 'channel.chat.message', version: '1' } as const;
export const BAN_EVENTS = [
  { type: 'channel.ban', version: '1' },
  { type: 'channel.unban', version: '1' },
] as const;

export type TwitchChatApiErrorKind =
  | 'unauthorized'
  | 'forbidden'
  | 'bad_request'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'dropped'
  | 'server_error'
  | 'network'
  | 'unexpected_response';

export class TwitchChatApiError extends Error {
  constructor(
    readonly kind: TwitchChatApiErrorKind,
    message: string,
    /** True when Twitch may have acted although the call failed (network failure or 5xx while sending). */
    readonly outcomeUnknown = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'TwitchChatApiError';
  }
}

export interface TwitchUserAuth {
  token: string;
  clientId: string;
}

/** Who acts where: the main account in its own channel. */
export interface TwitchModerator {
  broadcasterId: string;
  moderatorId: string;
}

const moderatorQuery = (m: TwitchModerator, extra: Record<string, string> = {}) =>
  new URLSearchParams({ broadcaster_id: m.broadcasterId, moderator_id: m.moderatorId, ...extra }).toString();

export class TwitchChatApi {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly onRateLimited: (retryAfterSeconds: number | undefined) => void;

  constructor(o: { fetch?: FetchLike; now?: () => Date; onRateLimited?: (retryAfterSeconds: number | undefined) => void } = {}) {
    this.fetchImpl = o.fetch ?? ((input, init) => fetch(input, init));
    this.now = o.now ?? (() => new Date());
    this.onRateLimited = o.onRateLimited ?? (() => {});
  }

  /** Subscribes the WebSocket session to a channel's chat, read as `userId`. Returns the subscription id. */
  async subscribeChat(auth: TwitchUserAuth, p: { sessionId: string; broadcasterUserId: string; userId: string }): Promise<string> {
    const body = await this.request(auth, 'POST /eventsub/subscriptions', '/eventsub/subscriptions', {
      type: CHAT_MESSAGE_EVENT.type,
      version: CHAT_MESSAGE_EVENT.version,
      condition: { broadcaster_user_id: p.broadcasterUserId, user_id: p.userId },
      transport: { method: 'websocket', session_id: p.sessionId },
    }, false);
    const sub = Array.isArray(body.data) ? (body.data[0] as { id?: unknown } | undefined) : undefined;
    if (typeof sub?.id !== 'string' || !sub.id) throw new TwitchChatApiError('unexpected_response', 'POST /eventsub/subscriptions: Twitch sent no subscription id');
    return sub.id;
  }

  /** Subscribes the session to one of a channel's events (only the broadcaster is in the condition). */
  async subscribeChannelEvent(auth: TwitchUserAuth, p: { sessionId: string; broadcasterUserId: string; event: { type: string; version: string } }): Promise<void> {
    await this.request(auth, 'POST /eventsub/subscriptions', '/eventsub/subscriptions', {
      type: p.event.type,
      version: p.event.version,
      condition: { broadcaster_user_id: p.broadcasterUserId },
      transport: { method: 'websocket', session_id: p.sessionId },
    }, false);
  }

  /** Bans a user, or times them out when durationSeconds is given. */
  async ban(auth: TwitchUserAuth, m: TwitchModerator, p: { userId: string; durationSeconds: number | null; reason: string | null }): Promise<void> {
    await this.request(auth, 'POST /moderation/bans', `/moderation/bans?${moderatorQuery(m)}`, {
      data: { user_id: p.userId, ...(p.durationSeconds !== null ? { duration: p.durationSeconds } : {}), ...(p.reason ? { reason: p.reason } : {}) },
    }, false);
  }

  /** Lifts a ban or a timeout. */
  async unban(auth: TwitchUserAuth, m: TwitchModerator, userId: string): Promise<void> {
    await this.request(auth, 'DELETE /moderation/bans', `/moderation/bans?${moderatorQuery(m, { user_id: userId })}`, undefined, false, 'DELETE');
  }

  async deleteMessage(auth: TwitchUserAuth, m: TwitchModerator, messageId: string): Promise<void> {
    await this.request(auth, 'DELETE /moderation/chat', `/moderation/chat?${moderatorQuery(m, { message_id: messageId })}`, undefined, false, 'DELETE');
  }

  /** Whether a user is one of the broadcaster's moderators. */
  async isModerator(auth: TwitchUserAuth, broadcasterId: string, userId: string): Promise<boolean> {
    const query = new URLSearchParams({ broadcaster_id: broadcasterId, user_id: userId }).toString();
    const body = await this.request(auth, 'GET /moderation/moderators', `/moderation/moderators?${query}`, undefined, false, 'GET');
    return Array.isArray(body.data) && body.data.length > 0;
  }

  async chatModes(auth: TwitchUserAuth, broadcasterId: string): Promise<TwitchChatModes> {
    const query = new URLSearchParams({ broadcaster_id: broadcasterId }).toString();
    return toChatModes(await this.request(auth, 'GET /chat/settings', `/chat/settings?${query}`, undefined, false, 'GET'));
  }

  async updateChatModes(auth: TwitchUserAuth, m: TwitchModerator, modes: TwitchChatModes): Promise<TwitchChatModes> {
    const body = await this.request(auth, 'PATCH /chat/settings', `/chat/settings?${moderatorQuery(m)}`, {
      slow_mode: modes.slowMode,
      ...(modes.slowMode ? { slow_mode_wait_time: modes.slowSeconds } : {}),
      follower_mode: modes.followersOnly,
      ...(modes.followersOnly ? { follower_mode_duration: modes.followerMinutes } : {}),
      subscriber_mode: modes.subscribersOnly,
      emote_mode: modes.emoteOnly,
      unique_chat_mode: modes.uniqueChat,
    }, false, 'PATCH');
    return toChatModes(body);
  }

  async shieldMode(auth: TwitchUserAuth, m: TwitchModerator): Promise<boolean> {
    return toShieldMode(await this.request(auth, 'GET /moderation/shield_mode', `/moderation/shield_mode?${moderatorQuery(m)}`, undefined, false, 'GET'));
  }

  async setShieldMode(auth: TwitchUserAuth, m: TwitchModerator, active: boolean): Promise<boolean> {
    return toShieldMode(await this.request(auth, 'PUT /moderation/shield_mode', `/moderation/shield_mode?${moderatorQuery(m)}`, { is_active: active }, false, 'PUT'));
  }

  /** Posts a chat message as `senderId` in `broadcasterUserId`'s chat. Resolves only when Twitch says it was sent. */
  async sendMessage(auth: TwitchUserAuth, p: { broadcasterUserId: string; senderId: string; message: string }): Promise<{ messageId: string | null }> {
    const body = await this.request(auth, 'POST /chat/messages', '/chat/messages', {
      broadcaster_id: p.broadcasterUserId,
      sender_id: p.senderId,
      message: p.message,
    }, true);
    const r = Array.isArray(body.data)
      ? (body.data[0] as { message_id?: unknown; is_sent?: unknown; drop_reason?: { code?: unknown; message?: unknown } | null } | undefined)
      : undefined;
    if (!r || typeof r.is_sent !== 'boolean') throw new TwitchChatApiError('unexpected_response', 'POST /chat/messages: Twitch sent an unexpected answer', true);
    if (!r.is_sent) {
      const why = typeof r.drop_reason?.message === 'string' && r.drop_reason.message.trim() ? r.drop_reason.message.trim().slice(0, 200) : 'no reason given';
      throw new TwitchChatApiError('dropped', why);
    }
    return { messageId: typeof r.message_id === 'string' && r.message_id ? r.message_id : null };
  }

  private async request(auth: TwitchUserAuth, label: string, path: string, json: unknown, sending: boolean, method = 'POST'): Promise<{ data?: unknown }> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${TWITCH_API_BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${auth.token}`, 'Client-Id': auth.clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // The request may have reached Twitch before the connection failed.
      throw new TwitchChatApiError('network', `${label}: Twitch couldn’t be reached`, sending);
    }
    const body = (await res.json().catch(() => null)) as { data?: unknown; message?: unknown } | null;
    const reason = typeof body?.message === 'string' && body.message.trim() ? `: ${body.message.trim().slice(0, 200)}` : '';
    if (res.status === 204) return {};
    if (res.ok) {
      if (!body) throw new TwitchChatApiError('unexpected_response', `${label}: Twitch sent an unexpected answer`, sending);
      return body;
    }
    if (res.status === 401) throw new TwitchChatApiError('unauthorized', `${label} was rejected (HTTP 401${reason})`);
    if (res.status === 403) throw new TwitchChatApiError('forbidden', `${label} was refused (HTTP 403${reason})`);
    if (res.status === 404) throw new TwitchChatApiError('not_found', `${label} found nothing (HTTP 404${reason})`);
    if (res.status === 409) throw new TwitchChatApiError('conflict', `${label} already exists (HTTP 409${reason})`);
    if (res.status === 429) {
      const reset = Number(res.headers.get('ratelimit-reset'));
      const seconds = Number.isFinite(reset) && reset > 0 ? Math.max(1, Math.ceil(reset - this.now().getTime() / 1000)) : undefined;
      this.onRateLimited(seconds);
      throw new TwitchChatApiError('rate_limited', `${label} was rate limited (HTTP 429)`, false, seconds);
    }
    if (res.status === 400 || res.status === 422) throw new TwitchChatApiError('bad_request', `${label} was rejected (HTTP ${res.status}${reason})`);
    if (res.status >= 500) throw new TwitchChatApiError('server_error', `${label} failed (HTTP ${res.status})`, sending);
    throw new TwitchChatApiError('unexpected_response', `${label} failed (HTTP ${res.status}${reason})`);
  }
}

/** Get and Update Chat Settings → the modes. A mode that's off has no value, so the usual one is shown for it. */
function toChatModes(body: { data?: unknown }): TwitchChatModes {
  const s = (Array.isArray(body.data) ? body.data[0] : undefined) as Record<string, unknown> | undefined;
  if (!s) throw new TwitchChatApiError('unexpected_response', 'GET /chat/settings: Twitch sent an unexpected answer');
  const seconds = Number(s.slow_mode_wait_time);
  const minutes = Number(s.follower_mode_duration);
  return {
    slowMode: s.slow_mode === true,
    slowSeconds: s.slow_mode_wait_time !== null && seconds >= 3 && seconds <= 120 ? seconds : 30,
    followersOnly: s.follower_mode === true,
    followerMinutes: s.follower_mode_duration !== null && minutes >= 0 && minutes <= 129_600 ? minutes : 0,
    subscribersOnly: s.subscriber_mode === true,
    emoteOnly: s.emote_mode === true,
    uniqueChat: s.unique_chat_mode === true,
  };
}

function toShieldMode(body: { data?: unknown }): boolean {
  const s = (Array.isArray(body.data) ? body.data[0] : body.data) as { is_active?: unknown } | undefined;
  if (typeof s?.is_active !== 'boolean') throw new TwitchChatApiError('unexpected_response', 'Shield Mode: Twitch sent an unexpected answer');
  return s.is_active;
}
