/**
 * Integration-test harness: a real server on an ephemeral loopback port, backed by an isolated in-memory
 * database, a controllable clock and a temporary log file. Never touches developer data.
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { migrate, migrations, openDatabase, type Database } from '@conduit/database';
import { createLogger, type Logger } from '@conduit/logger';
import { loadServerConfig, type ServerConfig } from '@conduit/shared';
import { startServer, type RunningServer } from '../../apps/server/src/server';
import { createServices, type Services } from '../../apps/server/src/services';
import type { BotClientFactory } from '../../apps/server/src/discord/discord-bot';
import type { Adapters } from '../../apps/server/src/app/registry';
import type { FetchLike } from '../../apps/server/src/app/types';
import type { CredentialVault } from '../../apps/server/src/app/vault';

/** The per-launch local access key the desktop would hold (test value). */
export const LOCAL_KEY = 'test-local-key-0123456789-abcdefghijklmnopqrs';
export const DASHBOARD_ORIGIN = 'app://conduit';

export class TestClock {
  constructor(private ms = Date.parse('2026-01-01T12:00:00.000Z')) {}
  now = (): Date => new Date(this.ms);
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface Harness {
  db: Database;
  services: Services;
  server: RunningServer;
  clock: TestClock;
  config: ServerConfig;
  logFile: string;
  logger: Logger;
  baseUrl: string;
  call<T = any>(method: string, urlPath: string, opts?: CallOptions): Promise<CallResult<T>>;
  /** Simulates a backend restart: new services and server (fresh in-memory state) on the same database. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export interface CallOptions {
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  /** Omit the local access key (to prove the API refuses such requests). */
  withoutLocalKey?: boolean;
}

export interface CallResult<T> {
  status: number;
  body: T;
  headers: Headers;
}

/** A currently free loopback port (for the OAuth callback listener in tests). */
/**
 * A port for a test server that must be known before it listens (OAuth callback, Kick webhook).
 *
 * Asking the OS for port 0 and releasing it races: Windows hands out its temporary ports (49152+) roughly in order,
 * so a parallel test process could be given the same number before our server binds it, and that server then fails
 * with "port in use". Instead each Vitest worker draws from its own block below the temporary range, so two workers
 * never pick the same port; each candidate is still checked (e.g. ports reserved by Windows are skipped).
 */
const PORT_BLOCK = 400;
const workerId = Number(process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? process.pid);
const portBase = 30_000 + (workerId % 40) * PORT_BLOCK;
let nextPort = 0;

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

export async function freePort(): Promise<number> {
  for (let i = 0; i < PORT_BLOCK; i++) {
    const port = portBase + (nextPort++ % PORT_BLOCK);
    if (await canBind(port)) return port;
  }
  throw new Error(`No free test port in ${portBase}–${portBase + PORT_BLOCK - 1}`);
}

export interface HarnessOptions {
  adapters?: Adapters;
  vault?: CredentialVault;
  /** Platform HTTP (e.g. FakeDiscord.fetch). Defaults to failing every request: tests never reach the real network. */
  fetch?: FetchLike;
  /** Discord bot gateway client. Defaults to one that can never connect. */
  botFactory?: BotClientFactory;
  /** Random numbers 0 ≤ n < 1 (Loyalty XP amounts). */
  random?: () => number;
  /** Kick's website (unofficial data, e.g. !followage and clips). Defaults to failing every request, like the network above. */
  kickWebFetch?: FetchLike;
  /** Twitch EventSub WebSocket (FakeTwitch.startEventSub). Defaults to a closed local port: never the real Twitch. */
  twitchEventSubUrl?: string;
}

const noNetwork: FetchLike = async () => {
  throw new TypeError('network access is disabled in tests');
};

const offlineBot: BotClientFactory = () => ({
  login: async () => {
    throw Object.assign(new Error('offline'), { code: 'ECONNREFUSED' });
  },
  destroy: async () => {},
  userInfo: () => null,
  guilds: () => [],
  on: () => {},
});

export async function createHarness(env: Record<string, string> = {}, opts: HarnessOptions = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conduit-test-'));
  const logFile = path.join(dir, 'server.log');
  const logger = createLogger({ name: 'test', level: 'debug', filePath: logFile, console: false });
  const db = openDatabase(':memory:');
  migrate(db, migrations);
  const clock = new TestClock();
  const config = loadServerConfig(
    { CONDUIT_PORT: '0', CONDUIT_ALLOWED_ORIGINS: DASHBOARD_ORIGIN, CONDUIT_OAUTH_CALLBACK_PORT: String(await freePort()), ...env },
    { dataDir: dir },
  );
  const boot = async () => {
    const services = createServices({
      db,
      config,
      logger,
      now: clock.now,
      adapters: opts.adapters,
      vault: opts.vault,
      fetch: opts.fetch ?? noNetwork,
      discordBotFactory: opts.botFactory ?? offlineBot,
      version: '9.9.9-test',
      // Background waits (e.g. command reply spacing) pass instantly on the test clock.
      sleep: async (ms: number) => clock.advance(ms),

      random: opts.random,
      kickWebFetch: opts.kickWebFetch ?? noNetwork,
      // Saved Kick clips go to the test's own folder, never the real Videos folder.
      clipsFolder: path.join(dir, 'clips'),
      twitchEventSubUrl: opts.twitchEventSubUrl ?? 'ws://127.0.0.1:9/ws',
    });
    const server = await startServer({ config, db, logger, version: '9.9.9-test', startedAt: new Date(), services, localKey: LOCAL_KEY });
    return { services, server, baseUrl: `http://127.0.0.1:${server.port}` };
  };

  const call = async <T>(method: string, urlPath: string, opts: CallOptions = {}): Promise<CallResult<T>> => {
    const headers: Record<string, string> = { ...(opts.withoutLocalKey ? {} : { 'X-CONDUIT-Local-Key': LOCAL_KEY }), ...opts.headers };
    let body: string | undefined = opts.rawBody;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    } else if (opts.rawBody !== undefined) {
      headers['Content-Type'] ??= 'application/json';
    }
    const res = await fetch(`${harness.baseUrl}${urlPath}`, { method, headers, body });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T, headers: res.headers };
  };

  const harness: Harness = {
    db,
    ...(await boot()),
    clock,
    config,
    logFile,
    logger,
    call,
    restart: async () => {
      await harness.server.close();
      Object.assign(harness, await boot());
    },
    close: async () => {
      await harness.server.close();
      db.close();
      logger.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

export function auditActions(h: Harness): Array<{ action: string; outcome: string; actorUserId: string | null; targetUserId: string | null; profileId: string | null; metadata: string }> {
  return h.db
    .prepare('SELECT action, outcome, actor_user_id AS actorUserId, target_user_id AS targetUserId, profile_id AS profileId, metadata FROM audit_logs ORDER BY id')
    .all() as never;
}

/**
 * HTTP status of a WebSocket upgrade attempt: 101 if it opened, the refusal's status, or 0 if the server closed the
 * connection without an answer. CONDUIT has no WebSocket endpoint, so nothing should ever open.
 */
export function upgradeStatus(h: Harness, options: WebSocket.ClientOptions = {}, wsPath = '/ws', withLocalKey = true): Promise<number> {
  const headers = { ...(withLocalKey ? { 'X-CONDUIT-Local-Key': LOCAL_KEY } : {}), ...options.headers };
  const ws = new WebSocket(`ws://127.0.0.1:${h.server.port}${wsPath}`, { ...options, headers });
  return new Promise((resolve) => {
    ws.once('unexpected-response', (req, res) => {
      res.resume();
      req.destroy();
      resolve(res.statusCode ?? 0);
    });
    ws.once('open', () => {
      ws.close();
      resolve(101);
    });
    ws.once('error', () => resolve(0));
  });
}
