import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type AppContext } from './app';

export interface RunningServer {
  port: number;
  /** Stops accepting connections and waits (bounded) for in-flight requests. */
  close(timeoutMs?: number): Promise<void>;
}

export async function startServer(ctx: AppContext): Promise<RunningServer> {
  const app = createApp(ctx);
  const server = http.createServer(app);
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  // Closes overdue giveaways now (e.g. after a restart) and keeps checking.
  ctx.services.giveaways.start();
  // Automated chat protection listens to Kick chat (it acts only when switched on).
  ctx.services.moderation.start();
  // Timed messages (schedules and chat counts), stream notifications (live checks) and Discord logging.
  ctx.services.timedMessages.start();
  ctx.services.notifications.start();
  // Kick clips: new ones are read (and posted) every few minutes while auto-posting is on.
  ctx.services.clips.start();
  // One automatic database backup per day (a missed one is made once, shortly after start).
  ctx.services.backups.start();
  // Pop-up alerts: watches the accounts for changes.
  ctx.services.alerts.start();
  ctx.services.protection.antiraid.start();
  void ctx.services.logging.start().catch((err) => ctx.logger.error('discord logging failed to start', { err }));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(ctx.config.port, ctx.config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const { port } = server.address() as AddressInfo;

  return {
    port,
    close: async (timeoutMs = 5000) => {
      await ctx.services.giveaways.close().catch(() => undefined);
      ctx.services.timedMessages.stop();
      ctx.services.notifications.stop();
      ctx.services.clips.stop();
      ctx.services.backups.stop();
      ctx.services.alerts.stop();
      ctx.services.protection.antiraid.stop();
      ctx.services.stickies.stop();
      ctx.services.logging.stop();
      await Promise.all([ctx.services.timedMessages.idle(), ctx.services.stickies.idle(), ctx.services.logging.idle(), ctx.services.loyalty.idle()]).catch(() => undefined);
      ctx.services.moderation.stop();
      await ctx.services.moderation.idle().catch(() => undefined);
      // The bot's gateway session closes cleanly before exit (exiting mid-close trips a libuv assertion).
      await ctx.services.discord.stopBot().catch(() => undefined);
      await ctx.services.kickChat.close().catch(() => undefined);
      await ctx.services.twitchChat.close().catch(() => undefined);
      await ctx.services.connections.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const timer = setTimeout(() => server.closeAllConnections(), timeoutMs);
      await closed;
      clearTimeout(timer);
    },
  };
}
