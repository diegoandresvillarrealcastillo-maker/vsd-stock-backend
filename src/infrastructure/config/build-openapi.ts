import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

// La version del contrato es la del paquete: una sola fuente de verdad.
const { version } = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
) as { version: string };

/** Construye el documento OpenAPI a partir de los controladores de la aplicacion. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('VSD Stock API')
    .setDescription(
      'API de VSD Stock: inventario, punto de venta, caja y reportes para MiPymes. ' +
        'Este documento es el contrato que une al backend con el frontend (ADR 0001).',
    )
    .setVersion(version)
    .build();
  return SwaggerModule.createDocument(app, config);
}

/** Serializacion unica del contrato: el archivo versionado y la comprobacion usan esta. */
export function serializeOpenApi(document: OpenAPIObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
