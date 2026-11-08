// What a giveaway says in each chat when it runs on Kick and Twitch together.
import { describe, expect, it } from 'vitest';
import type { GiveawayRecord } from '@conduit/database';
import { redrawMessage, startedMessage, winnersMessage } from '../../apps/server/src/community/giveaway-service';

const giveaway = (over: Partial<GiveawayRecord>) =>
  ({ prize: 'Key', winnerCount: 1, durationMinutes: null, allowKick: true, allowTwitch: true, allowDiscord: false, kickRewardTitle: null, ...over }) as GiveawayRecord;

describe('started message', () => {
  it('only Kick chat hears about Kick’s Channel Points reward', () => {
    const g = giveaway({ kickRewardTitle: 'Bonus ticket' });
    expect(startedMessage(g, undefined, 'kick')).toContain('Redeem “Bonus ticket”');
    expect(startedMessage(g, undefined, 'twitch')).not.toContain('Redeem');
  });

  it('says the same way to enter for both chats, and adds Discord’s', () => {
    expect(startedMessage(giveaway({}), undefined, 'twitch')).toContain('To enter, type !enter in chat.');
    expect(startedMessage(giveaway({ allowKick: false, allowDiscord: true }), undefined, 'twitch')).toContain('type !enter in chat or click Enter Giveaway on the Discord announcement');
  });
});

describe('winner names', () => {
  const twitchWinner = { platform: 'twitch', displayName: 'Fan' } as const;
  const kickWinner = { platform: 'kick', displayName: 'Viewer' } as const;

  it('say which chat they’re from only when the giveaway ran on both', () => {
    expect(winnersMessage('Key', [kickWinner, twitchWinner], undefined, giveaway({}))).toBe('🏆 Winners of Key: @Viewer (Kick), @Fan (Twitch). Congratulations!');
    expect(winnersMessage('Key', [twitchWinner], undefined, giveaway({ allowKick: false }))).toBe('🏆 Winner of Key: @Fan. Congratulations!');
    expect(redrawMessage('Key', twitchWinner, undefined, giveaway({}))).toContain('@Fan (Twitch)');
  });
});
