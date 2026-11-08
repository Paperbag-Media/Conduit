import { Router } from 'express';
import { AppError } from '../errors';
import type { Services } from '../services';

/**
 * /api/moderation — moderation for the desktop dashboard. Protected by the local access key (applied in app.ts), like
 * every /api route: only the desktop app that launched the backend can moderate. Platform permissions are checked by
 * the service and, finally, by Discord, Kick and Twitch themselves.
 */
export function createModerationRouter(services: Services): Router {
  const { moderation } = services;
  const router = Router();

  router.get('/moderation', async (_req, res) => {
    res.json(await moderation.state());
  });

  // The moderation pages: Kick and Twitch (automated protection, logs) and Discord (protection, logs).
  router.get('/moderation/kick', (_req, res) => {
    res.json(moderation.kickState());
  });

  router.get('/moderation/twitch', (_req, res) => {
    res.json(moderation.twitchState());
  });

  router.get('/moderation/discord', async (_req, res) => {
    res.json(await moderation.discordModerationState());
  });

  // Looks up a Discord member (by ID or mention) or a Kick user (by username) before acting.
  router.post('/moderation/lookup', async (req, res) => {
    res.json(await moderation.lookup(req.body));
  });

  // One action. The platform's outcome comes back either way (and is recorded); errors mean nothing was sent.
  router.post('/moderation/actions', async (req, res) => {
    res.json(await moderation.act(req.body));
  });

  router.post('/moderation/automod', (req, res) => {
    res.json(moderation.saveAutomod(req.body));
  });

  // Kick raid mode: start it now, or end it ({ active }).
  router.post('/moderation/raid', (req, res) => {
    res.json(moderation.setRaid(activeFlag(req.body)));
  });

  router.post('/moderation/twitch/automod', (req, res) => {
    res.json(moderation.saveTwitchAutomod(req.body));
  });

  // Twitch raid mode: start it now, or end it ({ active }).
  router.post('/moderation/twitch/raid', (req, res) => {
    res.json(moderation.setTwitchRaid(activeFlag(req.body)));
  });

  // Twitch's own chat modes and Shield Mode.
  router.get('/moderation/twitch/chat-modes', async (_req, res) => {
    res.json(await moderation.twitchChatModes());
  });

  router.post('/moderation/twitch/chat-modes', async (req, res) => {
    res.json(await moderation.saveTwitchChatModes(req.body));
  });

  router.post('/moderation/twitch/shield-mode', async (req, res) => {
    res.json(await moderation.setTwitchShieldMode(activeFlag(req.body)));
  });

  // Everything recorded for one person (a POST: no ids in query strings).
  router.post('/moderation/user-history', async (req, res) => {
    res.json(await moderation.userHistory(req.body));
  });

  return router;
}

function activeFlag(body: unknown): boolean {
  const active = (body as { active?: unknown } | undefined)?.active;
  if (typeof active !== 'boolean') throw new AppError('validation_error', 'active must be true or false');
  return active;
}
