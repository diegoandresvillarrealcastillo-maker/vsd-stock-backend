import { Logger } from '@nestjs/common';
import { createApp } from './config/create-app.js';
import { readConfig } from './config/env.js';

async function bootstrap(): Promise<void> {
  const config = readConfig(process.env);
  const app = await createApp({
    corsOrigins: config.corsOrigins,
    ...(config.database === undefined ? {} : { databaseUrl: config.database.url }),
  });
  // Con SIGTERM (docker stop, el host) las conexiones a la base se cierran antes de salir.
  app.enableShutdownHooks();
  await app.listen(config.port);
  const logger = new Logger('Bootstrap');
  logger.log(`vsd-stock-backend escuchando en el puerto ${config.port}`);
  logger.log(
    config.corsOrigins.length === 0
      ? 'CORS: ningun origen permitido (CORS_ORIGINS sin definir)'
      : `CORS: permitidos ${config.corsOrigins.join(', ')}`,
  );
  // Solo a donde apunta: la cadena de conexion lleva la clave y nunca se imprime.
  logger.log(
    config.database === undefined
      ? 'Base de datos: sin configurar (DATABASE_URL sin definir)'
      : `Base de datos: ${config.database.target}`,
  );
}

bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
