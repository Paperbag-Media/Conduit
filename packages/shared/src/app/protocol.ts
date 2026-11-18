import { z } from 'zod';

/** GET /api/health */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  version: z.string(),
  time: z.string(),
  uptimeSeconds: z.number().nonnegative(),
  database: z.object({
    ok: z.boolean(),
    schemaVersion: z.number().int().nonnegative(),
  }),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ── errors ──────────────────────────────────────────────────────────────────

export const API_ERROR_CODES = [
  'bad_request',
  'validation_error',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'not_implemented',
  'not_configured',
  'internal_error',
  'service_unavailable',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    /** Field-level validation problems; paths and messages only, never submitted values. */
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
export type ApiErrorBody = ApiError['error'];
