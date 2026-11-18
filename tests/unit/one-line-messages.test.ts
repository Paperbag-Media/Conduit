// Chat messages typed into CONDUIT must be one line: Twitch and Kick show no line breaks, and control characters
// could be used to hide text. Every control character (U+0000–U+001F) and DEL (U+007F) is refused.
import { describe, expect, it } from 'vitest';
import { sendTwitchChatSchema, timedMessageSchema } from '@conduit/shared';

const CONTROL = [...Array.from({ length: 32 }, (_, i) => String.fromCharCode(i)), '\u007f'];
const twitchTimed = (content: string) => timedMessageSchema.safeParse({ platform: 'twitch', name: 'Promo', content, intervalMinutes: 30 });
const kickTimed = (content: string) => timedMessageSchema.safeParse({ platform: 'kick', name: 'Promo', content, intervalMinutes: 30 });

describe('one-line chat messages', () => {
  it('accepts ordinary text, emoji and accents', () => {
    for (const text of ['Follow the stream!', 'Café ☕ and 🎉 tonight', 'a - b ~ c']) {
      expect(sendTwitchChatSchema.safeParse({ content: text }).success).toBe(true);
      expect(twitchTimed(text).success).toBe(true);
      expect(kickTimed(text).success).toBe(true);
    }
  });

  it('refuses every control character and DEL inside the text, on Twitch and Kick alike', () => {
    for (const c of CONTROL) {
      const text = `before${c}after`;
      expect(sendTwitchChatSchema.safeParse({ content: text }).success, `Twitch chat, U+${c.charCodeAt(0).toString(16)}`).toBe(false);
      expect(twitchTimed(text).success, `Twitch timed, U+${c.charCodeAt(0).toString(16)}`).toBe(false);
      expect(kickTimed(text).success, `Kick timed, U+${c.charCodeAt(0).toString(16)}`).toBe(false);
    }
  });

  it('says why', () => {
    expect(sendTwitchChatSchema.safeParse({ content: 'two\nlines' }).error?.issues[0]?.message).toBe('Messages are a single line of text');
    expect(twitchTimed('two\nlines').error?.issues.map((i) => i.message)).toContain('Twitch messages are one line');
  });
});
