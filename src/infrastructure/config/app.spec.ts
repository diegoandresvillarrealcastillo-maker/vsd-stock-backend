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
});
