import { readFileSync } from 'node:fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findConventionViolations } from '../../adapters/in/http/api-conventions.js';
import { buildOpenApiDocument, serializeOpenApi } from './build-openapi.js';
import { createApp } from './create-app.js';

// El contrato OpenAPI es lo unico que acopla backend y frontend (ADR 0001).
// Esta prueba es la comprobacion que hace fallar el CI si el contrato
// versionado y el codigo dejan de coincidir.
describe('OpenAPI contract', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await createApp({ quiet: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('describes GET /health with the two fields the use case returns', () => {
    const document = buildOpenApiDocument(app);

    const response = document.paths['/health']?.get?.responses?.['200'];
    expect(response).toBeDefined();

    const schema = document.components?.schemas?.['HealthReportDto'];
    expect(schema).toMatchObject({
      type: 'object',
      required: ['status', 'timestamp'],
      properties: {
        status: { type: 'string', enum: ['ok'] },
        timestamp: { type: 'string', format: 'date-time' },
      },
    });
  });

  it('publishes the error format as a schema, so that the frontend can type it', () => {
    const schema = buildOpenApiDocument(app).components?.schemas?.['ProblemDetailsDto'];

    expect(schema).toMatchObject({
      type: 'object',
      required: ['type', 'title', 'status', 'detail', 'instance', 'code', 'traceId'],
      properties: {
        type: { type: 'string' },
        status: { type: 'integer' },
        code: { type: 'string' },
        traceId: { type: 'string' },
        errors: { type: 'array' },
      },
    });
  });

  it('declares a problem+json default response on GET /health', () => {
    const response = buildOpenApiDocument(app).paths['/health']?.get?.responses?.['default'];

    expect(response).toMatchObject({
      content: {
        'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetailsDto' } },
      },
    });
  });

  it('follows every convention of the API (ADR 0019)', () => {
    expect(findConventionViolations(buildOpenApiDocument(app))).toEqual([]);
  });

  it('takes its version from package.json, the single source of truth', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(buildOpenApiDocument(app).info.version).toBe(pkg.version);
  });

  it('matches the committed openapi.json (after changing the API run `npm run openapi`)', () => {
    const committed = readFileSync(new URL('../../../openapi.json', import.meta.url), 'utf8');

    expect(serializeOpenApi(buildOpenApiDocument(app))).toBe(committed);
  });
});
