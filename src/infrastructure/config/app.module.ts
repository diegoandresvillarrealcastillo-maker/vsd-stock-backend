import {
  Inject,
  Injectable,
  Module,
  Optional,
  type DynamicModule,
  type OnModuleDestroy,
} from '@nestjs/common';
import { HealthController } from '../../adapters/in/http/health.controller.js';
import { ReadinessController } from '../../adapters/in/http/readiness.controller.js';
import { GET_HEALTH, GET_READINESS } from '../../adapters/in/http/tokens.js';
import { SystemClock } from '../../adapters/out/clock/system-clock.js';
import { createPrismaClient } from '../../adapters/out/persistence/create-prisma-client.js';
import { NotConfiguredDatabase } from '../../adapters/out/persistence/not-configured-database.js';
import { PrismaDatabaseHealth } from '../../adapters/out/persistence/prisma-database-health.js';
import { PrismaUnitOfWork } from '../../adapters/out/persistence/prisma-unit-of-work.js';
import { GetHealthUseCase } from '../../application/usecases/get-health.usecase.js';
import { GetReadinessUseCase } from '../../application/usecases/get-readiness.usecase.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import type { DatabaseHealth } from '../../domain/ports/out/database-health.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { CLOCK, DATABASE_HEALTH, PRISMA_CLIENT, UNIT_OF_WORK } from './tokens.js';

export interface AppModuleOptions {
  /** La conexion de la aplicacion (rol `stock_app`). Sin ella la API arranca, pero sin base de datos. */
  readonly databaseUrl?: string;
}

/** Cierra las conexiones a la base cuando la aplicacion se cierra, para que el proceso pueda terminar. */
@Injectable()
class DatabaseShutdown implements OnModuleDestroy {
  constructor(@Optional() @Inject(PRISMA_CLIENT) private readonly prisma?: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    await this.prisma?.$disconnect();
  }
}

/**
 * Cableado: aqui, y solo aqui, se decide que adaptador implementa cada
 * puerto y se arma cada caso de uso con sus dependencias.
 */
@Module({})
export class AppModule {
  static register(options: AppModuleOptions = {}): DynamicModule {
    const databaseProviders =
      options.databaseUrl === undefined
        ? [
            // Sin base: el servicio arranca, /health responde y todo lo que pida datos dice con claridad que falta.
            { provide: DATABASE_HEALTH, useClass: NotConfiguredDatabase },
            { provide: UNIT_OF_WORK, useClass: NotConfiguredDatabase },
          ]
        : [
            { provide: PRISMA_CLIENT, useValue: createPrismaClient(options.databaseUrl) },
            {
              provide: DATABASE_HEALTH,
              useFactory: (prisma: PrismaClient) => new PrismaDatabaseHealth(prisma),
              inject: [PRISMA_CLIENT],
            },
            {
              provide: UNIT_OF_WORK,
              useFactory: (prisma: PrismaClient) => new PrismaUnitOfWork(prisma),
              inject: [PRISMA_CLIENT],
            },
          ];

    return {
      module: AppModule,
      controllers: [HealthController, ReadinessController],
      providers: [
        { provide: CLOCK, useClass: SystemClock },
        ...databaseProviders,
        DatabaseShutdown,
        {
          provide: GET_HEALTH,
          useFactory: (clock: Clock) => new GetHealthUseCase(clock),
          inject: [CLOCK],
        },
        {
          provide: GET_READINESS,
          useFactory: (clock: Clock, database: DatabaseHealth) =>
            new GetReadinessUseCase(clock, database),
          inject: [CLOCK, DATABASE_HEALTH],
        },
      ],
      exports: [UNIT_OF_WORK],
    };
  }
}
