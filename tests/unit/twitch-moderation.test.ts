// Migration 32, and reading Twitch's chat and ban events.
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, migrations, moderationRepo, openDatabase, twitchChattersRepo, type Database } from '@conduit/database';
import { parseTwitchBan, parseTwitchChatMessage } from '../../apps/server/src/twitch/twitch-chat-service';

let db: Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

const AT = '2026-11-06T12:00:00.000Z';
const ID = '00000000-0000-4000-8000-000000000001';

describe('migration 32', () => {
  const old = (): Database => {
    const d = openDatabase(':memory:');
    migrate(d, migrations.slice(0, 31));
    d.exec(`
      INSERT INTO moderation_actions (id, created_at, platform, place_id, place_name, action, target_user_id, target_name, message_id, duration_seconds, reason, source, actor, rule, outcome, detail)
        VALUES ('${ID}', '${AT}', 'kick', '1', 'Channel', 'timeout', '2', 'Viewer', 'm1', 60, 'why', 'automod', 'Mod', 'raid', 'failed', 'detail');
    `);
    return d;
  };

  it('keeps every moderation record, unchanged', () => {
    db = old();
    const before = db.prepare('SELECT * FROM moderation_actions').all();
    expect(migrate(db, migrations).applied).toEqual([32]);
    expect(db.prepare('SELECT * FROM moderation_actions').all()).toEqual(before);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'moderation_actions' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual([
      { name: 'moderation_actions_created' },
      { name: 'moderation_actions_target' },
    ]);
  });

  it('accepts Twitch records and still refuses unknown platforms', () => {
    db = old();
    migrate(db, migrations);
    const record = { id: '00000000-0000-4000-8000-000000000002', createdAt: AT, platform: 'twitch', placeId: '1', placeName: 'c', action: 'ban', targetUserId: '2', targetName: 'v', messageId: null, durationSeconds: null, reason: null, source: 'platform', actor: 'm', rule: null, outcome: 'success', detail: null } as const;
    moderationRepo.insert(db, record);
    expect(moderationRepo.list(db, 10, 'twitch')).toEqual([record]);
    expect(() => moderationRepo.insert(db!, { ...record, id: '00000000-0000-4000-8000-000000000003', platform: 'youtube' as 'twitch' })).toThrow(/CHECK/);
  });

  it('remembers Twitch chatters apart from Kick’s', () => {
    db = old();
    migrate(db, migrations);
    expect(twitchChattersRepo.seen(db, '5', 'Fan', AT)).toBe(true);
    expect(twitchChattersRepo.seen(db, '5', 'Fan', AT)).toBe(false);
    expect(twitchChattersRepo.count(db)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM kick_chatters').get()).toMatchObject({ n: 0 });
  });
});

describe('chat events', () => {
  const event = (fragments: unknown) => ({
    message_id: 'abc',
    message: { text: 'hi LUL', fragments },
    chatter_user_id: '2',
    chatter_user_login: 'fan',
    chatter_user_name: 'ファン',
    broadcaster_user_id: '1',
  });

  it('keep the login, and write emotes the way the text checks read them', () => {
    const m = parseTwitchChatMessage(event([{ type: 'text', text: 'hi ' }, { type: 'emote', text: 'LUL', emote: { id: '425618' } }]), AT);
    expect(m).toMatchObject({ content: 'hi LUL', senderLogin: 'fan', senderUsername: 'ファン', checkText: 'hi [emote:0:e]' });
  });

  it('have no separate text to check without emotes, or without fragments', () => {
    expect(parseTwitchChatMessage(event([{ type: 'text', text: 'hi LUL' }]), AT)).not.toHaveProperty('checkText');
    expect(parseTwitchChatMessage(event('nonsense'), AT)).not.toHaveProperty('checkText');
  });
});

describe('ban events', () => {
  const ban = { broadcaster_user_id: '1', user_id: '2', user_login: 'fan', user_name: 'Fan', moderator_user_name: 'Mod', reason: ' rude ', banned_at: AT, ends_at: '2026-11-06T12:05:00.000Z', is_permanent: false };

  it('read a timeout, a ban and an unban', () => {
    expect(parseTwitchBan(ban, 'e1', 'ban', 'now')).toEqual({ id: 'e1', kind: 'ban', broadcasterUserId: '1', userId: '2', userName: 'Fan', moderatorName: 'Mod', reason: 'rude', at: AT, expiresAt: ban.ends_at });
    expect(parseTwitchBan({ ...ban, ends_at: null, is_permanent: true, reason: '' }, 'e2', 'ban', 'now')).toMatchObject({ expiresAt: null, reason: null });
    expect(parseTwitchBan({ broadcaster_user_id: '1', user_id: '2', user_login: 'fan' }, 'e3', 'unban', AT)).toMatchObject({ kind: 'unban', userName: 'fan', moderatorName: null, at: AT });
  });

  it('are ignored when malformed', () => {
    expect(parseTwitchBan(null, 'e', 'ban', AT)).toBeNull();
    expect(parseTwitchBan({ ...ban, user_id: 'x' }, 'e', 'ban', AT)).toBeNull();
    expect(parseTwitchBan({ ...ban, broadcaster_user_id: undefined }, 'e', 'ban', AT)).toBeNull();
  });
});
