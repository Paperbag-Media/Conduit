// Migration 31 rebuilds giveaways and giveaway_entries; what points at them must survive it.
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, migrations, openDatabase, type Database } from '@conduit/database';

let db: Database;
afterEach(() => db.close());

const AT = '2026-11-01T12:00:00.000Z';
const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

function oldDatabase(): Database {
  const d = openDatabase(':memory:');
  migrate(d, migrations.slice(0, 30));
  d.exec(`
    INSERT INTO giveaways (id, prize, status, winner_count, allow_kick, allow_discord, created_at, updated_at, kick_reward_cost, kick_reward_tickets, kick_reward_title, subscriber_multiplier)
      VALUES ('g1', 'Prize', 'drawn', 1, 1, 1, '${AT}', '${AT}', 500, 2, 'Ticket', 3);
    INSERT INTO giveaway_entries (id, giveaway_id, platform, platform_user_id, display_name, entered_at, source, subscriber_verified)
      VALUES (7, 'g1', 'kick', '100', 'Viewer', '${AT}', 'chat', 1);
    INSERT INTO giveaway_draws (id, giveaway_id, kind, drawn_at, pool_size) VALUES ('d1', 'g1', 'initial', '${AT}', 1);
    INSERT INTO giveaway_winners (id, giveaway_id, draw_id, entry_id, position, status, selected_at) VALUES ('w1', 'g1', 'd1', 7, 1, 'won', '${AT}');
    INSERT INTO giveaway_redemptions (id, giveaway_id, reward_id, redeemer_user_id, redeemed_at, status, tickets, processed_at)
      VALUES ('r1', 'g1', 'rw', '100', '${AT}', 'accepted', 2, '${AT}');
  `);
  return d;
}

describe('migration 31', () => {
  it('keeps every giveaway, entry, draw, winner and redemption', () => {
    db = oldDatabase();
    expect(migrate(db, migrations.slice(0, 31)).applied).toEqual([31]);
    expect(db.prepare('SELECT prize, allow_kick, allow_discord, allow_twitch, kick_reward_cost, subscriber_multiplier FROM giveaways').get()).toMatchObject({
      prize: 'Prize',
      allow_kick: 1,
      allow_discord: 1,
      allow_twitch: 0,
      kick_reward_cost: 500,
      subscriber_multiplier: 3,
    });
    expect(db.prepare('SELECT id, platform, subscriber_verified FROM giveaway_entries').get()).toMatchObject({ id: 7, platform: 'kick', subscriber_verified: 1 });
    expect([count('giveaway_draws'), count('giveaway_winners'), count('giveaway_redemptions')]).toEqual([1, 1, 1]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('leaves foreign keys on, so deleting a giveaway still removes what belongs to it', () => {
    db = oldDatabase();
    migrate(db, migrations);
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
    db.exec("DELETE FROM giveaways WHERE id = 'g1'");
    expect([count('giveaway_entries'), count('giveaway_draws'), count('giveaway_winners'), count('giveaway_redemptions')]).toEqual([0, 0, 0, 0]);
  });

  it('allows a Twitch-only giveaway with Twitch entries, keeps the indexes, and still needs a platform', () => {
    db = oldDatabase();
    migrate(db, migrations);
    db.exec(`
      INSERT INTO giveaways (id, prize, status, winner_count, allow_kick, allow_discord, allow_twitch, created_at, updated_at) VALUES ('g2', 'Prize', 'open', 1, 0, 0, 1, '${AT}', '${AT}');
      INSERT INTO giveaway_entries (giveaway_id, platform, platform_user_id, display_name, entered_at) VALUES ('g2', 'twitch', '200', 'Fan', '${AT}');
    `);
    expect(() => db.exec(`INSERT INTO giveaways (id, prize, status, winner_count, allow_kick, allow_discord, allow_twitch, created_at, updated_at) VALUES ('g3', 'Prize', 'open', 1, 0, 1, 0, '${AT}', '${AT}')`)).toThrow(/UNIQUE/);
    expect(() => db.exec(`INSERT INTO giveaways (id, prize, status, winner_count, allow_kick, allow_discord, allow_twitch, created_at, updated_at) VALUES ('g4', 'Prize', 'closed', 1, 0, 0, 0, '${AT}', '${AT}')`)).toThrow(/CHECK/);
  });
});
