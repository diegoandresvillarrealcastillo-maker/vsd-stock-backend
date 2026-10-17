import {
  Inject,
  Injectable,
  Module,
  Optional,
  type DynamicModule,
  type OnModuleDestroy,
  type Provider,
} from '@nestjs/common';
import {
  BusinessesController,
  InvitationsController,
  UsersController,
} from '../../adapters/in/http/business-people.controller.js';
import {
  CategoriesController,
  ProductsController,
} from '../../adapters/in/http/catalog.controller.js';
import { HealthController } from '../../adapters/in/http/health.controller.js';
import { MeController } from '../../adapters/in/http/me.controller.js';
import { ReadinessController } from '../../adapters/in/http/readiness.controller.js';
import {
  AUTHENTICATE,
  CATEGORIES,
  CREATE_BUSINESS,
  GET_HEALTH,
  GET_ME,
  GET_READINESS,
  INVITE_USER,
  LIST_USERS,
  PRODUCTS,
  REDEEM_INVITATION,
  REGENERATE_INVITATION,
  UPDATE_USER,
} from '../../adapters/in/http/tokens.js';
import { SystemClock } from '../../adapters/out/clock/system-clock.js';
import { JoseTokenVerifier } from '../../adapters/out/identity/jose-token-verifier.js';
import { UnconfiguredTokenVerifier } from '../../adapters/out/identity/unconfigured-token-verifier.js';
import { CryptoInvitationCodes } from '../../adapters/out/invitations/crypto-invitation-codes.js';
import { createPrismaClient } from '../../adapters/out/persistence/create-prisma-client.js';
import { NotConfiguredDatabase } from '../../adapters/out/persistence/not-configured-database.js';
import { PrismaBusinessSetup } from '../../adapters/out/persistence/prisma-business-setup.js';
import { PrismaDatabaseHealth } from '../../adapters/out/persistence/prisma-database-health.js';
import { PrismaIdentityDirectory } from '../../adapters/out/persistence/prisma-identity-directory.js';
import { PrismaInvitationRedeemer } from '../../adapters/out/persistence/prisma-invitation-redeemer.js';
import { PrismaUnitOfWork } from '../../adapters/out/persistence/prisma-unit-of-work.js';
import { AuthenticateUseCase } from '../../application/usecases/authenticate.usecase.js';
import { CategoriesUseCase } from '../../application/usecases/categories.usecase.js';
import { CreateBusinessUseCase } from '../../application/usecases/create-business.usecase.js';
import { GetHealthUseCase } from '../../application/usecases/get-health.usecase.js';
import { GetMeUseCase } from '../../application/usecases/get-me.usecase.js';
import { GetReadinessUseCase } from '../../application/usecases/get-readiness.usecase.js';
import { InviteUserUseCase } from '../../application/usecases/invite-user.usecase.js';
import { ListUsersUseCase } from '../../application/usecases/list-users.usecase.js';
import { ProductsUseCase } from '../../application/usecases/products.usecase.js';
import { RedeemInvitationUseCase } from '../../application/usecases/redeem-invitation.usecase.js';
import { RegenerateInvitationUseCase } from '../../application/usecases/regenerate-invitation.usecase.js';
import { UpdateUserUseCase } from '../../application/usecases/update-user.usecase.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import type { BusinessSetup } from '../../domain/ports/out/business-setup.js';
import type { DatabaseHealth } from '../../domain/ports/out/database-health.js';
import type { IdentityDirectory } from '../../domain/ports/out/identity-directory.js';
import type { InvitationCodes } from '../../domain/ports/out/invitation-codes.js';
import type { InvitationRedeemer } from '../../domain/ports/out/invitation-redeemer.js';
import type { TokenVerifier } from '../../domain/ports/out/token-verifier.js';
import type { UnitOfWork } from '../../domain/ports/out/unit-of-work.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import type { AuthConfig } from './env.js';
import {
  BUSINESS_SETUP,
  CLOCK,
  DATABASE_HEALTH,
  IDENTITY_DIRECTORY,
  INVITATION_CODES,
  INVITATION_REDEEMER,
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
            { provide: BUSINESS_SETUP, useClass: NotConfiguredDatabase },
            { provide: INVITATION_REDEEMER, useClass: NotConfiguredDatabase },
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
            {
              provide: BUSINESS_SETUP,
              useFactory: (work: PrismaUnitOfWork) => new PrismaBusinessSetup(work),
              inject: [UNIT_OF_WORK],
            },
            {
              provide: INVITATION_REDEEMER,
              useFactory: (prisma: PrismaClient) => new PrismaInvitationRedeemer(prisma),
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

    // Negocio y personas (ADR 0023).
    const peopleProviders: Provider[] = [
      { provide: INVITATION_CODES, useClass: CryptoInvitationCodes },
      {
        provide: CREATE_BUSINESS,
        useFactory: (setup: BusinessSetup) => new CreateBusinessUseCase(setup),
        inject: [BUSINESS_SETUP],
      },
      {
        provide: INVITE_USER,
        useFactory: (work: UnitOfWork, codes: InvitationCodes, clock: Clock) =>
          new InviteUserUseCase(work, codes, clock),
        inject: [UNIT_OF_WORK, INVITATION_CODES, CLOCK],
      },
      {
        provide: REGENERATE_INVITATION,
        useFactory: (work: UnitOfWork, codes: InvitationCodes, clock: Clock) =>
          new RegenerateInvitationUseCase(work, codes, clock),
        inject: [UNIT_OF_WORK, INVITATION_CODES, CLOCK],
      },
      {
        provide: REDEEM_INVITATION,
        useFactory: (redeemer: InvitationRedeemer, codes: InvitationCodes, clock: Clock) =>
          new RedeemInvitationUseCase(redeemer, codes, clock),
        inject: [INVITATION_REDEEMER, INVITATION_CODES, CLOCK],
      },
      {
        provide: LIST_USERS,
        useFactory: (work: UnitOfWork) => new ListUsersUseCase(work),
        inject: [UNIT_OF_WORK],
      },
      {
        provide: UPDATE_USER,
        useFactory: (work: UnitOfWork) => new UpdateUserUseCase(work),
        inject: [UNIT_OF_WORK],
      },
    ];

    // Catalogo (ADR 0015).
    const catalogProviders: Provider[] = [
      {
        provide: CATEGORIES,
        useFactory: (work: UnitOfWork) => new CategoriesUseCase(work),
        inject: [UNIT_OF_WORK],
      },
      {
        provide: PRODUCTS,
        useFactory: (work: UnitOfWork) => new ProductsUseCase(work),
        inject: [UNIT_OF_WORK],
      },
    ];

    return {
      module: AppModule,
      controllers: [
        HealthController,
        ReadinessController,
        MeController,
        BusinessesController,
        InvitationsController,
        UsersController,
        CategoriesController,
        ProductsController,
      ],
      providers: [
        { provide: CLOCK, useClass: SystemClock },
        ...databaseProviders,
        ...identityProviders,
        ...peopleProviders,
        ...catalogProviders,
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
