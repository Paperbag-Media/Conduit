// Migration 33: one open giveaway per side (stream / Discord) instead of one overall. Rows are unchanged.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { giveawaysRepo, migrate, migrations } from '@conduit/database';

const AT = '2026-11-17T12:00:00.000Z';
let db: DatabaseSync | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

const insert = (id: string, status: string, kick: 0 | 1, discord: 0 | 1, twitch: 0 | 1) =>
  db!.exec(
    `INSERT INTO giveaways (id, prize, status, winner_count, allow_kick, allow_discord, allow_twitch, created_at, updated_at) VALUES ('${id}', 'Prize', '${status}', 1, ${kick}, ${discord}, ${twitch}, '${AT}', '${AT}')`,
  );

describe('migration 33', () => {
  it('keeps an open giveaway from before (Kick and Discord together) as the open stream giveaway', () => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, migrations.filter((m) => m.version < 33));
    insert('old', 'open', 1, 1, 0);
    insert('done', 'drawn', 0, 1, 0);
    const before = db.prepare('SELECT * FROM giveaways ORDER BY id').all();
    expect(migrate(db, migrations).applied).toEqual([33]);
    expect(db.prepare('SELECT * FROM giveaways ORDER BY id').all()).toEqual(before);
    expect(giveawaysRepo.findOpen(db, 'stream')?.id).toBe('old');
    expect(giveawaysRepo.findOpen(db, 'discord')).toBeUndefined();
  });

  it('allows one open giveaway per side', () => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db, migrations);
    insert('stream', 'open', 1, 0, 1);
    insert('discord', 'open', 0, 1, 0);
    expect(() => insert('twitch', 'open', 0, 0, 1)).toThrow(/UNIQUE/);
    expect(() => insert('discord2', 'open', 0, 1, 0)).toThrow(/UNIQUE/);
    insert('closed', 'closed', 0, 1, 0); // only open giveaways count
    expect(giveawaysRepo.findOpen(db, 'stream')?.id).toBe('stream');
    expect(giveawaysRepo.findOpen(db, 'discord')?.id).toBe('discord');
  });
});
