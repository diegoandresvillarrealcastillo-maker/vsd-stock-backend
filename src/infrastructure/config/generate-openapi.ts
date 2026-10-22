import { writeFileSync } from 'node:fs';
import { buildOpenApiDocument, serializeOpenApi } from './build-openapi.js';
import { createApp } from './create-app.js';

/**
 * Escribe openapi.json en la raiz del repositorio. Se ejecuta con
 * `npm run openapi` despues de compilar. El archivo se versiona: es el
 * contrato que el frontend usa para derivar sus tipos.
 */
const app = await createApp({ quiet: true });
await app.init();
writeFileSync(
  new URL('../../../openapi.json', import.meta.url),
  serializeOpenApi(buildOpenApiDocument(app)),
);
await app.close();
