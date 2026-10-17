import {
  Inject,
  Injectable,
  Module,
  Optional,
  type DynamicModule,
  type OnModuleDestroy,
  type Provider,
} from '@nestjs/common';
import { HealthController } from '../../adapters/in/http/health.controller.js';
import { MeController } from '../../adapters/in/http/me.controller.js';
import { ReadinessController } from '../../adapters/in/http/readiness.controller.js';
import { AUTHENTICATE, GET_HEALTH, GET_ME, GET_READINESS } from '../../adapters/in/http/tokens.js';
import { SystemClock } from '../../adapters/out/clock/system-clock.js';
import { JoseTokenVerifier } from '../../adapters/out/identity/jose-token-verifier.js';
import { UnconfiguredTokenVerifier } from '../../adapters/out/identity/unconfigured-token-verifier.js';
import { createPrismaClient } from '../../adapters/out/persistence/create-prisma-client.js';
import { NotConfiguredDatabase } from '../../adapters/out/persistence/not-configured-database.js';
import { PrismaDatabaseHealth } from '../../adapters/out/persistence/prisma-database-health.js';
import { PrismaIdentityDirectory } from '../../adapters/out/persistence/prisma-identity-directory.js';
import { PrismaUnitOfWork } from '../../adapters/out/persistence/prisma-unit-of-work.js';
import { AuthenticateUseCase } from '../../application/usecases/authenticate.usecase.js';
import { GetHealthUseCase } from '../../application/usecases/get-health.usecase.js';
import { GetMeUseCase } from '../../application/usecases/get-me.usecase.js';
import { GetReadinessUseCase } from '../../application/usecases/get-readiness.usecase.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import type { DatabaseHealth } from '../../domain/ports/out/database-health.js';
import type { IdentityDirectory } from '../../domain/ports/out/identity-directory.js';
import type { TokenVerifier } from '../../domain/ports/out/token-verifier.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AuthConfig } from './env.js';
import {
  CLOCK,
  DATABASE_HEALTH,
  IDENTITY_DIRECTORY,
  PRISMA_CLIENT,
  TOKEN_VERIFIER,
  UNIT_OF_WORK,
} from './tokens.js';

export interface AppModuleOptions {
  /** La conexion de la aplicacion (rol `stock_app`). Sin ella la API arranca, pero sin base de datos. */
  readonly databaseUrl?: string;
  /** El servicio de identidad. Sin el la API arranca, pero ninguna peticion de una persona se puede atender. */
  readonly auth?: AuthConfig;
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
    const databaseProviders: Provider[] =
      options.databaseUrl === undefined
        ? [
            // Sin base: el servicio arranca, /health responde y todo lo que pida datos dice con claridad que falta.
            { provide: DATABASE_HEALTH, useClass: NotConfiguredDatabase },
            { provide: UNIT_OF_WORK, useClass: NotConfiguredDatabase },
            { provide: IDENTITY_DIRECTORY, useClass: NotConfiguredDatabase },
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
            {
              provide: IDENTITY_DIRECTORY,
              useFactory: (prisma: PrismaClient) => new PrismaIdentityDirectory(prisma),
              inject: [PRISMA_CLIENT],
            },
          ];

    const identityProviders: Provider[] = [
      options.auth === undefined
        ? // Sin servicio de identidad: la API arranca y dice con claridad que falta, no rechaza a todos como si su token fuera malo.
          { provide: TOKEN_VERIFIER, useClass: UnconfiguredTokenVerifier }
        : { provide: TOKEN_VERIFIER, useValue: new JoseTokenVerifier(options.auth) },
      {
        provide: AUTHENTICATE,
        useFactory: (tokens: TokenVerifier, directory: IdentityDirectory) =>
          new AuthenticateUseCase(tokens, directory),
        inject: [TOKEN_VERIFIER, IDENTITY_DIRECTORY],
      },
      {
        provide: GET_ME,
        useFactory: (work: UnitOfWork) => new GetMeUseCase(work),
        inject: [UNIT_OF_WORK],
      },
    ];

    return {
      module: AppModule,
      controllers: [HealthController, ReadinessController, MeController],
      providers: [
        { provide: CLOCK, useClass: SystemClock },
        ...databaseProviders,
        ...identityProviders,
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
