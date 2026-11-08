/**
 * What Kick's and Twitch's default commands share: which are switched on, their cooldowns, recent runs, and the answers
 * that work the same everywhere (!ping, !commands, !addcom…). Each platform's service adds its own answers; its command
 * service runs them through the same pipeline as custom commands (the chatbot sends the reply, with its spacing and loop
 * protection), so these services only decide the reply.
 *
 * - A custom command with the same trigger takes the default's place while it exists and is on.
 * - Everyone's commands have a short shared cooldown so chat can't be flooded; moderator commands have none.
 * - Replies never start with "!" or "/", so they can't trigger another command.
 */
import { settingsRepo, type Database } from '@conduit/database';
import type { Logger } from '@conduit/logger';
import {
  defaultCommandSettingsSchema,
  type ChatDefaultCommandDefinition,
  type CommandRun,
  type CommandsHubState,
  type DefaultCommandSettings,
  type DefaultCommandView,
} from '@conduit/shared';
import { AppError } from '../errors';
import { parseInput } from '../validation';
import type { CustomCommandService } from './custom-command-service';

/** Shared cooldown of everyone's default commands (seconds). */
const EVERYONE_COOLDOWN_S = 10;
/** Kick and Twitch chat messages are at most 500 characters. */
const MAX_REPLY = 480;
const RECENT_KEPT = 20;

export interface DefaultCommandContext {
  /** The sender's name and id on the platform. */
  user: string;
  userId: string;
  /** Everything after the trigger. */
  args: string;
  /** A moderator or the broadcaster (skips the shared cooldown of everyone's commands). */
  privileged: boolean;
}

export interface DefaultCommandDeps {
  db: Database;
  now: () => Date;
  logger: Logger;
  customCommands: CustomCommandService;
  /** Triggers everyone may use in this chat now (default and custom), for !commands. */
  everyoneCommands: () => string[];
}

type Outcome = CommandRun['outcome'];

export abstract class DefaultCommandService {
  private readonly cooling = new Map<string, number>();
  private readonly recentRuns: CommandsHubState['recent'] = [];

  protected constructor(
    private readonly platform: 'kick' | 'twitch',
    private readonly definitions: readonly ChatDefaultCommandDefinition[],
    private readonly settingKey: string,
    private readonly deps: DefaultCommandDeps,
  ) {}

  /** The platform's own answers (null: nothing to say). */
  protected abstract answer(trigger: string, ctx: DefaultCommandContext): Promise<string | null>;

  /** Why a command that's on can't answer yet (e.g. a permission is missing), else null. */
  protected unavailable(_trigger: string): string | null {
    return null;
  }

  settings(): DefaultCommandSettings {
    const raw = settingsRepo.get(this.deps.db, this.settingKey);
    try {
      const parsed = defaultCommandSettingsSchema.safeParse(raw ? JSON.parse(raw) : {});
      if (parsed.success) return { disabled: parsed.data.disabled.filter((t) => this.definitions.some((d) => d.trigger === t)) };
    } catch {
      // unreadable: all on
    }
    return { disabled: [] };
  }

  save(raw: unknown): DefaultCommandView[] {
    const input = parseInput(defaultCommandSettingsSchema, raw);
    const unknown = input.disabled.filter((t) => !this.definitions.some((d) => d.trigger === t));
    if (unknown.length) throw new AppError('validation_error', 'Some fields are invalid', { issues: [{ path: 'disabled', message: `${unknown[0]} isn’t a ${this.label} default command` }] });
    settingsRepo.set(this.deps.db, this.settingKey, JSON.stringify({ disabled: [...new Set(input.disabled)].sort() }), this.deps.now().toISOString());
    this.deps.logger.info(`${this.platform} default commands saved`, { disabled: input.disabled.length });
    return this.views();
  }

  /** The defaults as the Commands page shows them. */
  views(): DefaultCommandView[] {
    const off = new Set(this.settings().disabled);
    return this.definitions.map((d) => ({
      trigger: d.trigger,
      description: d.description,
      permission: d.permission,
      enabled: !off.has(d.trigger),
      canDisable: true,
      inactiveReason: off.has(d.trigger) ? null : this.deps.customCommands.findRunnable(this.platform, d.trigger) ? `Your custom ${d.trigger} answers instead` : this.unavailable(d.trigger),
      args: [...d.args],
      example: d.example,
      message: d.message,
    }));
  }

  /** The default command for a trigger, when it's on and no custom command takes its place. */
  find(trigger: string): ChatDefaultCommandDefinition | null {
    const d = this.definitions.find((c) => c.trigger === trigger);
    if (!d || this.settings().disabled.includes(d.trigger)) return null;
    return this.deps.customCommands.findRunnable(this.platform, trigger) ? null : d;
  }

  /** Checks and reserves the shared cooldown of everyone's commands (moderators and the broadcaster skip it). */
  admit(d: ChatDefaultCommandDefinition, privileged = false): { ok: true; release: () => void } | { ok: false; remainingSeconds: number } {
    if (d.permission !== 'everyone' || privileged) return { ok: true, release: () => {} };
    const now = this.deps.now().getTime();
    const until = this.cooling.get(d.trigger) ?? 0;
    if (until > now) return { ok: false, remainingSeconds: Math.ceil((until - now) / 1000) };
    const mine = now + EVERYONE_COOLDOWN_S * 1000;
    this.cooling.set(d.trigger, mine);
    return { ok: true, release: () => this.cooling.get(d.trigger) === mine && this.cooling.delete(d.trigger) };
  }

  record(trigger: string, outcome: Outcome, detail: string | null): void {
    this.recentRuns.unshift({ at: this.deps.now().toISOString(), trigger, outcome, detail });
    this.recentRuns.splice(RECENT_KEPT);
  }

  recent(): CommandsHubState['recent'] {
    return [...this.recentRuns];
  }

  /** The reply to post (null: nothing to say). Never starts with "!" or "/". */
  async run(d: ChatDefaultCommandDefinition, ctx: DefaultCommandContext): Promise<string | null> {
    const reply = this.sharedAnswer(d.trigger, ctx) ?? (await this.answer(d.trigger, ctx));
    if (!reply) return null;
    const safe = reply.replace(/^[!/]+/, '').trim();
    return safe.length > MAX_REPLY ? `${safe.slice(0, MAX_REPLY - 1)}…` : safe;
  }

  private get label(): string {
    return this.platform === 'kick' ? 'Kick' : 'Twitch';
  }

  private sharedAnswer(trigger: string, ctx: DefaultCommandContext): string | null {
    switch (trigger) {
      case '!ping':
        return 'Pong! I’m connected and ready!';
      case '!commands': {
        const list = this.deps.everyoneCommands();
        return list.length ? `Commands: ${list.join(', ')}` : 'There are no commands yet.';
      }
      case '!addcom':
      case '!editcom':
      case '!delcom':
        return this.manageCommand(trigger, ctx.args);
      default:
        return null;
    }
  }

  private manageCommand(trigger: string, args: string): string {
    const words = args.split(/\s+/).filter(Boolean);
    const target = words[0]?.toLowerCase();
    const usage = trigger === '!delcom' ? '!delcom !name' : `${trigger} !name reply`;
    if (!target) return `Use: ${usage}`;
    const name = target.startsWith('!') ? target : `!${target}`;
    const reply = args.trim().slice(words[0]!.length).trim();
    const reason = (err: unknown) => (err instanceof AppError ? (err.options.issues?.[0]?.message ?? err.message) : 'Something went wrong.');
    const commands = this.deps.customCommands;
    const existing = commands.list(this.platform).find((c) => c.trigger === name);
    try {
      if (trigger === '!addcom') {
        if (!reply) return `Use: ${usage}`;
        commands.create(this.platform, { trigger: name, response: reply });
        return `Added ${name}.`;
      }
      if (!existing) return `There’s no custom ${name}.`;
      if (trigger === '!editcom') {
        if (!reply) return `Use: ${usage}`;
        commands.update(this.platform, existing.id, { response: reply });
        return `Updated ${name}.`;
      }
      commands.remove(this.platform, existing.id);
      return `Deleted ${name}.`;
    } catch (err) {
      return `Couldn’t ${trigger === '!addcom' ? 'add' : trigger === '!editcom' ? 'update' : 'delete'} ${name}: ${reason(err)}`;
    }
  }
}
