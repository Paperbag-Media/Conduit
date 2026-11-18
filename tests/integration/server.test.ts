import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { healthResponseSchema } from '@conduit/shared';
import { createHarness, DASHBOARD_ORIGIN, LOCAL_KEY, upgradeStatus, type Harness } from '../helpers/harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.close();
});

function rawRequest(
  pathname: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: h.server.port, path: pathname, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HTTP API baseline', () => {
  it('reports health without authentication and without account data', async () => {
    const res = await rawRequest('/api/health');
    expect(res.status).toBe(200);
    const body = healthResponseSchema.parse(JSON.parse(res.body));
    expect(body).toMatchObject({ status: 'ok', version: '9.9.9-test', database: { ok: true, schemaVersion: 33 } });
    expect(Object.keys(body).sort()).toEqual(['database', 'status', 'time', 'uptimeSeconds', 'version']);
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('returns JSON 404s outside /api', async () => {
    const res = await rawRequest('/nope');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body)).toEqual({ error: { code: 'not_found', message: 'Not found' } });
  });

  it('denies unknown /api paths to unauthenticated callers (deny by default)', async () => {
    const res = await rawRequest('/api/nope');
    expect(res.status).toBe(401);
  });

  it('rejects non-loopback Host headers (DNS rebinding)', async () => {
    expect((await rawRequest('/api/health', { Host: 'attacker.example:47820' })).status).toBe(403);
  });

  it('allows the dashboard origin via CORS', async () => {
    const res = await rawRequest('/api/health', { Origin: DASHBOARD_ORIGIN });
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(DASHBOARD_ORIGIN);
  });

  it('refuses other browser origins, even with the local access key', async () => {
    const res = await rawRequest('/api/connections', { Origin: 'https://evil.example', 'X-CONDUIT-Local-Key': LOCAL_KEY });
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers preflight requests for the dashboard origin', async () => {
    const res = await rawRequest('/api/health', { Origin: DASHBOARD_ORIGIN, 'Access-Control-Request-Method': 'POST' }, 'OPTIONS');
    expect(res.status).toBe(204);
  });
});

describe('no WebSocket endpoint', () => {
  it('never upgrades a connection, from the dashboard origin, another origin or another host', async () => {
    for (const options of [{ origin: DASHBOARD_ORIGIN }, { origin: 'https://evil.example' }, { headers: { Host: 'attacker.example' } }, {}]) {
      expect(await upgradeStatus(h, options)).not.toBe(101);
      expect(await upgradeStatus(h, options, '/other')).not.toBe(101);
    }
    // An upgrade request is an ordinary request here, so the same guards answer it: Host check first, then not found.
    expect(await upgradeStatus(h, { headers: { Host: 'attacker.example' } })).toBe(403);
    expect(await upgradeStatus(h, {})).toBe(404);
  });
});
