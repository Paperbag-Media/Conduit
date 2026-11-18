/**
 * Migration 33 — Discord giveaways and stream giveaways run separately.
 *
 * A giveaway is either a stream giveaway (entered from Kick or Twitch chat) or a Discord giveaway (entered with the
 * embed's button only). One of each may be open at the same time, so the one-open rule becomes one open giveaway per
 * side. The side is derived from the entry platforms, not stored: a giveaway that allows Kick or Twitch is a stream
 * giveaway (this includes giveaways made before this migration that also allowed Discord). No rows change.
 * NEVER edit this SQL after release — add a new migration instead.
 */
export const GIVEAWAY_SIDES_MIGRATION_SQL = `
DROP INDEX giveaways_one_open;
CREATE UNIQUE INDEX giveaways_one_open_per_side ON giveaways ((allow_kick = 1 OR allow_twitch = 1)) WHERE status = 'open';
`;
