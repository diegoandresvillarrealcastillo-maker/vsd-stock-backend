import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

export interface CreateAppOptions {
  /** Apaga el registro de Nest. Las pruebas lo usan para no llenar la salida. */
  readonly quiet?: boolean;
}

/** Arma la aplicacion con su configuracion comun. main.ts y las pruebas usan esta misma. */
export async function createApp(options: CreateAppOptions = {}): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule,
    options.quiet === true ? { logger: false } : {},
  );
  // No anunciamos el framework en cada respuesta.
  app.disable('x-powered-by');
  return app;
}
