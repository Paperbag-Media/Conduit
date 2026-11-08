/**
 * Migration 31 — giveaways can take entries from Twitch chat.
 *
 * giveaways gets allow_twitch (a giveaway needs at least one of the three platforms) and giveaway_entries accepts
 * platform 'twitch'. SQLite can't change a CHECK constraint in place, so both tables are rebuilt: a new table with the
 * wider rules, every existing row copied unchanged, then swapped in. Draws, winners and redemptions point at these
 * tables, and dropping a table would delete them through ON DELETE CASCADE, so this migration runs with foreign keys off
 * (rebuildsTables) and every reference is checked before it commits.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const GIVEAWAY_TWITCH_MIGRATION_SQL = `
CREATE TABLE giveaways_v31 (
  id                   TEXT PRIMARY KEY,
  prize                TEXT NOT NULL CHECK (length(prize) BETWEEN 1 AND 100),
  description          TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500),
  status               TEXT NOT NULL CHECK (status IN ('draft', 'open', 'closed', 'drawn', 'cancelled')),
  winner_count         INTEGER NOT NULL CHECK (winner_count BETWEEN 1 AND 50),
  duration_minutes     INTEGER CHECK (duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 10080),
  allow_kick           INTEGER NOT NULL CHECK (allow_kick IN (0, 1)),
  allow_discord        INTEGER NOT NULL CHECK (allow_discord IN (0, 1)),
  allow_twitch         INTEGER NOT NULL DEFAULT 0 CHECK (allow_twitch IN (0, 1)),
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  started_at           TEXT,
  ends_at              TEXT,
  closed_at            TEXT,
  drawn_at             TEXT,
  cancelled_at         TEXT,
  announce_at          TEXT,
  announce_kind        TEXT CHECK (announce_kind IS NULL OR announce_kind IN ('started', 'closed', 'winners', 'redraw')),
  announce_outcome     TEXT CHECK (announce_outcome IS NULL OR announce_outcome IN ('sent', 'failed', 'unconfirmed', 'skipped')),
  announce_detail      TEXT CHECK (announce_detail IS NULL OR length(announce_detail) <= 300),
  discord_guild_id     TEXT CHECK (discord_guild_id IS NULL OR (length(discord_guild_id) BETWEEN 1 AND 25 AND discord_guild_id NOT GLOB '*[^0-9]*')),
  discord_channel_id   TEXT CHECK (discord_channel_id IS NULL OR (length(discord_channel_id) BETWEEN 1 AND 25 AND discord_channel_id NOT GLOB '*[^0-9]*')),
  discord_channel_name TEXT CHECK (discord_channel_name IS NULL OR length(discord_channel_name) BETWEEN 1 AND 100),
  discord_message_id   TEXT CHECK (discord_message_id IS NULL OR (length(discord_message_id) BETWEEN 1 AND 25 AND discord_message_id NOT GLOB '*[^0-9]*')),
  discord_status       TEXT CHECK (discord_status IS NULL OR discord_status IN ('posted', 'failed', 'missing')),
  discord_detail       TEXT CHECK (discord_detail IS NULL OR length(discord_detail) <= 300),
  discord_updated_at   TEXT,
  kick_reward_cost     INTEGER CHECK (kick_reward_cost IS NULL OR kick_reward_cost BETWEEN 1 AND 10000000),
  kick_reward_tickets  INTEGER CHECK (kick_reward_tickets IS NULL OR kick_reward_tickets BETWEEN 1 AND 100),
  kick_reward_title    TEXT CHECK (kick_reward_title IS NULL OR length(kick_reward_title) BETWEEN 1 AND 50),
  kick_reward_id       TEXT CHECK (kick_reward_id IS NULL OR length(kick_reward_id) BETWEEN 1 AND 64),
  kick_reward_status   TEXT CHECK (kick_reward_status IS NULL OR kick_reward_status IN ('active', 'paused', 'removed', 'failed')),
  kick_reward_detail   TEXT CHECK (kick_reward_detail IS NULL OR length(kick_reward_detail) <= 300),
  subscriber_multiplier INTEGER NOT NULL DEFAULT 1 CHECK (subscriber_multiplier BETWEEN 1 AND 10),
  CHECK (allow_kick = 1 OR allow_discord = 1 OR allow_twitch = 1)
) STRICT;

INSERT INTO giveaways_v31 (id, prize, description, status, winner_count, duration_minutes, allow_kick, allow_discord, created_at,
    updated_at, started_at, ends_at, closed_at, drawn_at, cancelled_at, announce_at, announce_kind, announce_outcome,
    announce_detail, discord_guild_id, discord_channel_id, discord_channel_name, discord_message_id, discord_status,
    discord_detail, discord_updated_at, kick_reward_cost, kick_reward_tickets, kick_reward_title, kick_reward_id,
    kick_reward_status, kick_reward_detail, subscriber_multiplier)
  SELECT id, prize, description, status, winner_count, duration_minutes, allow_kick, allow_discord, created_at,
    updated_at, started_at, ends_at, closed_at, drawn_at, cancelled_at, announce_at, announce_kind, announce_outcome,
    announce_detail, discord_guild_id, discord_channel_id, discord_channel_name, discord_message_id, discord_status,
    discord_detail, discord_updated_at, kick_reward_cost, kick_reward_tickets, kick_reward_title, kick_reward_id,
    kick_reward_status, kick_reward_detail, subscriber_multiplier
  FROM giveaways;

DROP TABLE giveaways;
ALTER TABLE giveaways_v31 RENAME TO giveaways;

CREATE UNIQUE INDEX giveaways_one_open ON giveaways (status) WHERE status = 'open';
CREATE INDEX giveaways_open_ends ON giveaways (ends_at) WHERE status = 'open';
CREATE UNIQUE INDEX giveaways_discord_message ON giveaways (discord_message_id) WHERE discord_message_id IS NOT NULL;

CREATE TABLE giveaway_entries_v31 (
  id                  INTEGER PRIMARY KEY,
  giveaway_id         TEXT NOT NULL REFERENCES giveaways (id) ON DELETE CASCADE,
  platform            TEXT NOT NULL CHECK (platform IN ('kick', 'discord', 'twitch')),
  platform_user_id    TEXT NOT NULL CHECK (length(platform_user_id) BETWEEN 1 AND 32),
  display_name        TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  entered_at          TEXT NOT NULL,
  source              TEXT CHECK (source IS NULL OR source IN ('chat', 'command', 'reaction')),
  subscriber_verified INTEGER NOT NULL DEFAULT 0 CHECK (subscriber_verified IN (0, 1)),
  subscriber_evidence TEXT CHECK (subscriber_evidence IS NULL OR (length(subscriber_evidence) <= 500 AND json_valid(subscriber_evidence))),
  UNIQUE (giveaway_id, platform, platform_user_id)
) STRICT;

INSERT INTO giveaway_entries_v31 (id, giveaway_id, platform, platform_user_id, display_name, entered_at, source, subscriber_verified, subscriber_evidence)
  SELECT id, giveaway_id, platform, platform_user_id, display_name, entered_at, source, subscriber_verified, subscriber_evidence
  FROM giveaway_entries;

DROP TABLE giveaway_entries;
ALTER TABLE giveaway_entries_v31 RENAME TO giveaway_entries;
`;
