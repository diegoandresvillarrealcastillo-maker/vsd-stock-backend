import {
  createReadinessReport,
  type ReadinessReport,
} from '../../domain/model/readiness-report.js';
import type { GetReadiness } from '../../domain/ports/in/get-readiness.js';
import type { Clock } from '../../domain/ports/out/clock.js';
import type { DatabaseHealth } from '../../domain/ports/out/database-health.js';

/** Caso de uso: informa si el servicio esta listo para trabajar, preguntandole a la base de datos. */
export class GetReadinessUseCase implements GetReadiness {
  constructor(
    private readonly clock: Clock,
    private readonly database: DatabaseHealth,
  ) {}

  async execute(): Promise<ReadinessReport> {
    // El puerto no deberia lanzar, pero una comprobacion que falla nunca cuenta como «lista».
    const status = await this.database.check().catch(() => 'down' as const);
    return createReadinessReport(this.clock.now(), status);
  }
}
