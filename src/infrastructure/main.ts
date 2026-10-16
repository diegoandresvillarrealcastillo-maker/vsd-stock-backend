import { Logger } from '@nestjs/common';
import { createApp } from './config/create-app.js';
import { readConfig } from './config/env.js';

async function bootstrap(): Promise<void> {
  const config = readConfig(process.env);
  const app = await createApp();
  await app.listen(config.port);
  new Logger('Bootstrap').log(`vsd-stock-backend escuchando en el puerto ${config.port}`);
}

bootstrap().catch((error: unknown) => {
  new Logger('Bootstrap').error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
