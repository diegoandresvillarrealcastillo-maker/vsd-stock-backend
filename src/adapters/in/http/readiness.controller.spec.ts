import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReadinessReport } from '../../../domain/model/readiness-report.js';
import type { GetReadiness } from '../../../domain/ports/in/get-readiness.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { ReadinessController } from './readiness.controller.js';
import { GET_READINESS } from './tokens.js';

describe('ReadinessController', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  // Lo que el doble del puerto de entrada contestara en cada prueba.
  let readiness: ReadinessReport;
  const getReadiness: GetReadiness = { execute: () => Promise.resolve(readiness) };

  beforeEach(async () => {
    readiness = { status: 'ok', database: 'up', timestamp: '2026-10-17T15:30:00.000Z' };
    const moduleRef = await Test.createTestingModule({
      controllers: [ReadinessController],
      providers: [{ provide: GET_READINESS, useValue: getReadiness }],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers GET /v1/ready with 200 and the report when the database answers', async () => {
    const response = await fetch(`${baseUrl}/v1/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      database: 'up',
      timestamp: '2026-10-17T15:30:00.000Z',
    });
  });

  it('answers 503 as a problem+json when the database does not answer', async () => {
    readiness = { status: 'unavailable', database: 'down', timestamp: '2026-10-17T15:30:00.000Z' };

    const response = await fetch(`${baseUrl}/v1/ready`);
    const problem = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/problem+json');
    expect(problem).toMatchObject({ status: 503, code: 'database-unavailable' });
  });

  it('answers 503 with its own code when no database was configured', async () => {
    readiness = {
      status: 'unavailable',
      database: 'not-configured',
      timestamp: '2026-10-17T15:30:00.000Z',
    };

    const response = await fetch(`${baseUrl}/v1/ready`);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'database-not-configured' });
  });
});
