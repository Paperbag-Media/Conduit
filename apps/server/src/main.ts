/**
 * Server entry point. Runs as an Electron utility process, launched by the desktop app's backend supervisor, which
 * supplies the data folder, the local access key and the credential vault. It refuses to run on its own.
 */
import path from 'node:path';
import {
  applyPendingRestore,
  checkIntegrity,
  DATABASE_FILE,
  migrate,
  migrations,
  openDatabase,
  type Database,
} from '@conduit/database';
import { createLogger } from '@conduit/logger';
import {
  ConfigError,
  EXIT_CONFIG_ERROR,
  EXIT_RESTART,
  loadServerConfig,
  type SupervisorMessage,
  type WorkerMessage,
} from '@conduit/shared';

import { ParentPortVault } from './app/vault';
import { startServer, type RunningServer } from './server';
import { createServices } from './services';

interface ParentPort {
  on(event: 'message', listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}
const parentPort = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  // Without the desktop app there is no credential vault and no local access key, so nothing could be connected.
  console.error('CONDUIT’s backend runs inside the CONDUIT app. Start CONDUIT instead.');
  process.exit(EXIT_CONFIG_ERROR);
}
const notifyParent = (message: WorkerMessage) => parentPort.postMessage(message);
/** Encrypted token storage lives in the desktop main process, reached over the private parent port. */
const vault = new ParentPortVault(parentPort);

const version = typeof __CONDUIT_VERSION__ === 'string' ? __CONDUIT_VERSION__ : '0.0.0-dev';

async function main(): Promise<void> {
  let config;
  // The desktop app always passes the data directory and the local access key.
  try {
    config = loadServerConfig(process.env);
    if (!config.localKey) throw new Error('CONDUIT_LOCAL_KEY is missing: the CONDUIT app supplies it.');
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : String(err);
    console.error(message);
    notifyParent({ type: 'fatal', message });
    process.exit(EXIT_CONFIG_ERROR); // The supervisor must not restart-loop on bad configuration.
  }

  const logger = createLogger({
    name: 'server',
    level: config.logLevel,
    filePath: path.join(config.dataDir, 'logs', 'server.log'),
    console: config.logToConsole,
  });
  logger.info('starting', { version, pid: process.pid, host: config.host, port: config.port, dataDir: config.dataDir });

  let db: Database | undefined;
  let server: RunningServer | undefined;
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { reason });
    try {
      await server?.close();
      db?.close();
    } catch (err) {
      logger.error('error during shutdown', { err });
      exitCode ||= 1;
    }
    logger.info('stopped');
    logger.close();
    process.exit(exitCode);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  parentPort.on('message', (e) => {
    const msg = e.data as SupervisorMessage | undefined;
    if (msg?.type === 'shutdown') void shutdown('supervisor request');
    else if (msg?.type === 'vault.response') vault.handleMessage(msg);
  });
  process.on('uncaughtException', (err) => {
    logger.error('uncaught exception', { err });
    void shutdown('uncaught exception', 1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled promise rejection', { err: reason });
  });

  try {
    // A restore chosen in Settings is applied here, before the database is opened (never to an open database).
    const restored = applyPendingRestore(config.dataDir, path.join(config.dataDir, DATABASE_FILE), {
      maxSchemaVersion: Math.max(...migrations.map((m) => m.version)),
      now: new Date(),
    });
    if (restored) (restored.ok ? logger.info : logger.error)('backup restore', { ok: restored.ok, file: restored.file, message: restored.message });
    db = openDatabase(path.join(config.dataDir, DATABASE_FILE));
    const problems = checkIntegrity(db);
    if (problems.length > 0) {
      // Refuse to write to a damaged database; the operator should restore a backup.
      throw new Error(`Database integrity check failed: ${problems.slice(0, 5).join('; ')}`);
    }
    const result = migrate(db, migrations);
    logger.info('database ready', { schemaVersion: result.currentVersion, applied: result.applied });

    const localKey = config.localKey!;

    const requestRestart = () => {
      // The supervisor restarts the backend right away (not counted as a crash).
      notifyParent({ type: 'restart' });
      void shutdown('restart requested (restore)', EXIT_RESTART);
    };
    const services = createServices({ db, config, logger, vault, version, requestRestart });
    server = await startServer({ config, db, logger, version, startedAt: new Date(), services, localKey });
    logger.info('listening', {
      url: `http://${config.host}:${server.port}`,
      oauthCallbackPort: config.oauthCallbackPort,
    });
    notifyParent({ type: 'ready', port: server.port });
    services.connections.startBackgroundVerification();
    void services.discord.startBot().catch((err) => logger.error('could not start the discord bot', { err }));
    void services.kickChat.start().catch((err) => logger.error('could not start kick chat', { err }));
    void services.twitchChat.start().catch((err) => logger.error('could not start twitch chat', { err }));
  } catch (err) {
    logger.error('startup failed', { err });
    notifyParent({ type: 'fatal', message: err instanceof Error ? err.message : String(err) });
    await shutdown('startup failure', 1);
  }
}

void main();
