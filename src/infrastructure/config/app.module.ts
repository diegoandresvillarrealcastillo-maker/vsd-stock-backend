import { Module } from '@nestjs/common';
import { HealthController } from '../../adapters/in/http/health.controller.js';
import { GET_HEALTH } from '../../adapters/in/http/tokens.js';
import { SystemClock } from '../../adapters/out/clock/system-clock.js';
import { GetHealthUseCase } from '../../application/usecases/get-health.usecase.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import { CLOCK } from './tokens.js';

/**
 * Cableado: aqui, y solo aqui, se decide que adaptador implementa cada
 * puerto y se arma cada caso de uso con sus dependencias.
 */
@Module({
  controllers: [HealthController],
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    {
      provide: GET_HEALTH,
      useFactory: (clock: Clock) => new GetHealthUseCase(clock),
      inject: [CLOCK],
    },
  ],
})
export class AppModule {}
