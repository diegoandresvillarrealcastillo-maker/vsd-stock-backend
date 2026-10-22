import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach, describe, expect, it } from 'vitest';
import { applicationUrlOf } from '../../scripts/prepare-database.ts';
import { createApp } from '../../src/infrastructure/config/create-app.js';
import { createAdminPool } from './support/database.js';

/**
 * El cableado completo con una base de verdad (ADR 0021): la aplicacion arranca con DATABASE_URL, dice que esta
 * lista cuando la base responde y que no cuando no, y nunca deja ver la cadena de conexion, que lleva la clave.
 */
describe('GET /v1/ready against PostgreSQL', () => {
  let app: NestExpressApplication | undefined;

  const start = async (databaseUrl: string): Promise<string> => {
    app = await createApp({ quiet: true, databaseUrl });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  };

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('is ready when the application role reaches the database', async () => {
    const baseUrl = await start(applicationUrlOf(process.env['TEST_DATABASE_URL']!));

    const response = await fetch(`${baseUrl}/v1/ready`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', database: 'up' });
  });

  it('is not ready, and says the database is unavailable, when nobody listens at its address', async () => {
    const baseUrl = await start('postgresql://stock_app:SecretoLargo123@127.0.0.1:1/stock_test');

    const response = await fetch(`${baseUrl}/v1/ready`);
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ code: 'database-unavailable' });
    // La cadena de conexion lleva la clave: no sale en ninguna respuesta.
    expect(text).not.toContain('SecretoLargo123');
    expect(text).not.toContain('127.0.0.1');
  });

  it('keeps answering GET /health even when the database is down: the process is alive', async () => {
    const baseUrl = await start('postgresql://stock_app@127.0.0.1:1/stock_test');

    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it('closes its connections when the application closes', async () => {
    const admin = createAdminPool(1);
    const sessions = async (): Promise<number> =>
      Number(
        (
          await admin.query<{ n: string }>(
            "SELECT count(*) AS n FROM pg_stat_activity WHERE usename = 'stock_app'",
          )
        ).rows[0]?.n,
      );
    try {
      const baseUrl = await start(applicationUrlOf(process.env['TEST_DATABASE_URL']!));
      await fetch(`${baseUrl}/v1/ready`);
      expect(await sessions()).toBeGreaterThan(0);

      await app!.close();
      app = undefined;

      // PostgreSQL tarda unos instantes en retirar la sesion de la lista.
      const deadline = Date.now() + 3000;
      while ((await sessions()) > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await sessions()).toBe(0);
    } finally {
      await admin.end();
    }
  });
});
