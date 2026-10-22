import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GetHealth } from '../../../domain/ports/in/get-health.js';
import { HealthController } from './health.controller.js';
import { GET_HEALTH } from './tokens.js';

describe('HealthController', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  // Doble del puerto de entrada: el controlador no debe saber quien lo implementa.
  const getHealth: GetHealth = {
    execute: () => ({ status: 'ok', timestamp: '2026-10-16T15:30:00.000Z' }),
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: GET_HEALTH, useValue: getHealth }],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers GET /health with 200 and the report the use case gives', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ status: 'ok', timestamp: '2026-10-16T15:30:00.000Z' });
  });
});
