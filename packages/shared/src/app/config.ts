import { z } from 'zod';
import { APP_ORIGIN, DEFAULT_API_PORT, isLoopbackHost, isValidOrigin } from './net';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const originList = z
  .string()
  .transform((s) =>
    s
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  )
  .pipe(
    z
      .array(z.string().refine(isValidOrigin, { message: 'must be an origin like scheme://host[:port]' }))
      .min(1),
  );

/**
 * Server configuration, read from CONDUIT_* environment variables.
 */
export const serverConfigSchema = z
  .object({
    host: z.string().min(1).default('127.0.0.1'),
    port: z.coerce.number().int().min(0).max(65535).default(DEFAULT_API_PORT),
    dataDir: z.string().min(1),
    logLevel: z.enum(LOG_LEVELS).default('info'),
    logToConsole: booleanString.default(true),
    allowedOrigins: originList.default([APP_ORIGIN]),
    /** Local access key required on every /api request (except health). The desktop app generates one per launch and is the only holder. */
    localKey: z.string().min(32).max(256).optional(),
    /**
     * Loopback port for OAuth redirects. Platforms match redirect URIs exactly, so this must equal the port in the
     * redirect URI registered with each platform (e.g. http://127.0.0.1:47821/oauth/discord/callback).
     */
    oauthCallbackPort: z.coerce.number().int().min(1024).max(65535).default(47821),
    /**
     * Loopback port of the Kick webhook receiver (accepts only Kick-signed chat events). Expose only this port with a
     * tunnel (Cloudflare Tunnel, ngrok); the API port stays unreachable from the network.
     */
    kickWebhookPort: z.coerce.number().int().min(1024).max(65535).default(47822),
  })
  .superRefine((cfg, ctx) => {
    // Remote access is intentionally disabled: exposing the server beyond this machine needs its own threat model
    // (authentication, transport security, abuse controls, origin handling). Do not relax this check without that work.
    if (!isLoopbackHost(cfg.host)) {
      ctx.addIssue({
        code: 'custom',
        path: ['host'],
        message:
          'Only loopback bind addresses (127.0.0.1, ::1, localhost) are allowed. Remote access is not supported yet.',
      });
    }
  });

export type ServerConfig = z.output<typeof serverConfigSchema>;

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const ENV_KEYS = {
  host: 'CONDUIT_HOST',
  port: 'CONDUIT_PORT',
  dataDir: 'CONDUIT_DATA_DIR',
  logLevel: 'CONDUIT_LOG_LEVEL',
  logToConsole: 'CONDUIT_LOG_CONSOLE',
  allowedOrigins: 'CONDUIT_ALLOWED_ORIGINS',
  localKey: 'CONDUIT_LOCAL_KEY',
  oauthCallbackPort: 'CONDUIT_OAUTH_CALLBACK_PORT',
  kickWebhookPort: 'CONDUIT_KICK_WEBHOOK_PORT',
} as const satisfies Record<keyof ServerConfig, `CONDUIT_${string}`>;

/** Reads `CONDUIT_<NAME>`. Empty values count as unset. */
export function envValue(env: Record<string, string | undefined>, name: `CONDUIT_${string}`): string | undefined {
  return env[name]?.trim() || undefined;
}

/** Builds and validates the server config from environment variables; throws ConfigError on invalid input. */
export function loadServerConfig(
  env: Record<string, string | undefined>,
  defaults: { dataDir?: string } = {},
): ServerConfig {
  const raw: Record<string, string | undefined> = {};
  for (const [key, envName] of Object.entries(ENV_KEYS)) raw[key] = envValue(env, envName);
  raw.dataDir ??= defaults.dataDir;

  const result = serverConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => {
        const field = issue.path[0];
        const envName = typeof field === 'string' && field in ENV_KEYS ? ENV_KEYS[field as keyof ServerConfig] : field;
        return `${String(envName)}: ${issue.message}`;
      }),
    );
  }
  return result.data;
}
