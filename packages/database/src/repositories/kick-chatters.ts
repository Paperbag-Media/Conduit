/**
 * Who has chatted in the main Kick channel (migration 29) and the main Twitch channel (migration 32) before: user id,
 * name, and first/last time seen. Raid mode uses it to tell first-time chatters from regulars, also across restarts. No
 * message text is kept.
 */
import { execute, queryOne, type Database } from '../sqlite';

export interface ChattersRepo {
  /** Records a chatter (or updates their name and last time). True when they had never chatted before. */
  seen(db: Database, userId: string, username: string, at: string): boolean;
  count(db: Database): number;
}

const chattersRepo = (table: 'kick_chatters' | 'twitch_chatters'): ChattersRepo => ({
  seen(db, userId, username, at) {
    const known = queryOne<{ user_id: string }>(db, `SELECT user_id FROM ${table} WHERE user_id = ?`, userId);
    execute(
      db,
      `INSERT INTO ${table} (user_id, username, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET username = excluded.username, last_seen_at = excluded.last_seen_at`,
      userId,
      username.slice(0, 64) || 'user',
      at,
      at,
    );
    return !known;
  },

  count(db) {
    return queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
  },
});

export const kickChattersRepo = chattersRepo('kick_chatters');
export const twitchChattersRepo = chattersRepo('twitch_chatters');
