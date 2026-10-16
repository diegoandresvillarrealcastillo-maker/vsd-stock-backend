import { readFileSync } from 'node:fs';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
