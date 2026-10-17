import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './create-app.js';

// Prueba de integracion del cableado: AppModule real, sin dobles.
describe('application wiring', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeEach(async () => {
    app = await createApp({ quiet: true });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves GET /health with the real use case and the real clock', async () => {
    const before = Date.now();

    const response = await fetch(`${baseUrl}/health`);
    const body = (await response.json()) as { status: string; timestamp: string };

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    const reported = new Date(body.timestamp).getTime();
    expect(reported).toBeGreaterThanOrEqual(before);
    expect(reported).toBeLessThanOrEqual(Date.now());
  });

  it('does not reveal the framework in the response headers', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.headers.get('x-powered-by')).toBeNull();
  });

  it('answers 404 to a route that does not exist', async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`);

    expect(response.status).toBe(404);
  });

  it('answers that 404 as a problem+json with a stable code and a trace id (ADR 0019)', async () => {
    const response = await fetch(`${baseUrl}/does-not-exist?token=secreto`);
    const problem = (await response.json()) as Record<string, unknown>;

    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(problem).toMatchObject({
      type: 'urn:vsd-stock:problem:not-found',
      status: 404,
      code: 'not-found',
      instance: '/does-not-exist',
    });
    expect(problem['traceId']).toBe(response.headers.get('x-request-id'));
    expect(JSON.stringify(problem)).not.toContain('secreto');
  });

  it('echoes the request id the caller sent and makes one when it sent none', async () => {
    const sent = await fetch(`${baseUrl}/health`, {
      headers: { 'X-Request-Id': 'device-0001-try-2' },
    });
    const made = await fetch(`${baseUrl}/health`);

    expect(sent.headers.get('x-request-id')).toBe('device-0001-try-2');
    expect(made.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never lets a response to GET /health be cached: the connection check must be live (ADR 0009)', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('never lets an error be cached either', async () => {
    const response = await fetch(`${baseUrl}/does-not-exist`);

    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('emits no CORS header when no origin is configured, even if the caller sends one', async () => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'http://localhost:5173' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('application wiring: CORS', () => {
  const ALLOWED = 'http://localhost:5173';
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeEach(async () => {
    app = await createApp({ quiet: true, corsOrigins: [ALLOWED, 'https://stock.example.com'] });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers an allowed origin with its own value, never with a wildcard', async () => {
    const response = await fetch(`${baseUrl}/health`, { headers: { Origin: ALLOWED } });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
  });

  it('answers the second origin of the list with its own value', async () => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://stock.example.com' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBe('https://stock.example.com');
  });

  it('tells caches that the answer depends on the origin', async () => {
    const response = await fetch(`${baseUrl}/health`, { headers: { Origin: ALLOWED } });

    expect(response.headers.get('vary')?.toLowerCase()).toContain('origin');
  });

  it('lets the browser read the headers a client needs: Retry-After, X-Request-Id and Idempotent-Replayed', async () => {
    const response = await fetch(`${baseUrl}/health`, { headers: { Origin: ALLOWED } });
    const exposed = (response.headers.get('access-control-expose-headers') ?? '').toLowerCase();

    for (const header of ['retry-after', 'x-request-id', 'idempotent-replayed']) {
      expect(exposed, header).toContain(header);
    }
  });

  it('does not allow credentials: the API will use a token in a header, not cookies', async () => {
    const response = await fetch(`${baseUrl}/health`, { headers: { Origin: ALLOWED } });

    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('gives an origin that is not in the list no permission', async () => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://evil.example.com' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('does not match an origin that only starts like an allowed one', async () => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: `${ALLOWED}.evil.example.com` },
    });

    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers the preflight of an allowed origin without a body and lets the browser cache it', async () => {
    const response = await fetch(`${baseUrl}/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: ALLOWED,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED);
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    );
    expect(response.headers.get('access-control-max-age')).toBe('86400');
    expect(await response.text()).toBe('');
  });

  it('gives the preflight of an origin that is not in the list no permission', async () => {
    const response = await fetch(`${baseUrl}/health`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example.com',
        'Access-Control-Request-Method': 'POST',
      },
    });

    // Lo que decide al navegador es la ausencia de Allow-Origin. La biblioteca
    // anuncia los metodos de todos modos y eso no concede nada.
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
