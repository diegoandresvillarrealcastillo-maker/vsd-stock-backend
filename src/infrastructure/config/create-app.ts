import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

export interface CreateAppOptions {
  /** Apaga el registro de Nest. Las pruebas lo usan para no llenar la salida. */
  readonly quiet?: boolean;
  /** Origenes a los que se les permite leer las respuestas desde un navegador. Por omision, ninguno. */
  readonly corsOrigins?: readonly string[];
}

/** Cuanto tiempo puede recordar el navegador una respuesta a la peticion previa (OPTIONS): un dia. */
const PREFLIGHT_MAX_AGE_SECONDS = 86_400;

/** Arma la aplicacion con su configuracion comun. main.ts y las pruebas usan esta misma. */
export async function createApp(options: CreateAppOptions = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    options.quiet === true ? { logger: false } : {},
  );
  // No anunciamos el framework en cada respuesta.
  app.disable('x-powered-by');

  const corsOrigins = options.corsOrigins ?? [];
  if (corsOrigins.length > 0) {
    // Lista exacta, nunca comodin y sin credenciales: la API usara un token en
    // una cabecera, no cookies (ADR 0012). La biblioteca responde con el valor
    // del propio origen y anade `Vary: Origin`.
    app.enableCors({
      origin: [...corsOrigins],
      methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
      maxAge: PREFLIGHT_MAX_AGE_SECONDS,
    });
  }
  return app;
}
