import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { noStoreMiddleware } from '../../adapters/in/http/no-store.js';
import { ProblemDetailsFilter } from '../../adapters/in/http/problem-details.filter.js';
import { requestIdMiddleware } from '../../adapters/in/http/request-id.js';
import { AppModule } from './app.module.js';

export interface CreateAppOptions {
  /** Apaga el registro de Nest. Las pruebas lo usan para no llenar la salida. */
  readonly quiet?: boolean;
  /** Origenes a los que se les permite leer las respuestas desde un navegador. Por omision, ninguno. */
  readonly corsOrigins?: readonly string[];
  /** La conexion de la aplicacion a la base de datos. Por omision, ninguna: la API arranca sin datos. */
  readonly databaseUrl?: string;
}

/** Cuanto tiempo puede recordar el navegador una respuesta a la peticion previa (OPTIONS): un dia. */
const PREFLIGHT_MAX_AGE_SECONDS = 86_400;

/** Arma la aplicacion con su configuracion comun. main.ts y las pruebas usan esta misma. */
export async function createApp(options: CreateAppOptions = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register(
      options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl },
    ),
    options.quiet === true ? { logger: false } : {},
  );
  // No anunciamos el framework en cada respuesta.
  app.disable('x-powered-by');
  // Cada peticion lleva un identificador y todo error sale como application/problem+json (ADR 0019).
  app.use(requestIdMiddleware);
  // Ninguna respuesta se guarda en una cache; un /health guardado diria que hay conexion cuando no la hay.
  app.use(noStoreMiddleware);
  app.useGlobalFilters(new ProblemDetailsFilter());

  const corsOrigins = options.corsOrigins ?? [];
  if (corsOrigins.length > 0) {
    // Lista exacta, nunca comodin y sin credenciales: la API usara un token en
    // una cabecera, no cookies (ADR 0012). La biblioteca responde con el valor
    // del propio origen y anade `Vary: Origin`.
    app.enableCors({
      origin: [...corsOrigins],
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      // Sin esto el navegador esconde estas cabeceras al cliente de otro origen: Retry-After lo exige el
      // ADR 0009, X-Request-Id une una queja con el registro e Idempotent-Replayed dice que fue una repeticion.
      exposedHeaders: ['Retry-After', 'X-Request-Id', 'Idempotent-Replayed'],
      maxAge: PREFLIGHT_MAX_AGE_SECONDS,
    });
  }
  return app;
}
