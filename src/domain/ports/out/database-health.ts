import type { DatabaseStatus } from '../../model/readiness-report.js';

export type { DatabaseStatus };

/** Puerto de salida: preguntarle a la base de datos si esta viva. Nunca lanza: «no responde» es una respuesta. */
export interface DatabaseHealth {
  check(): Promise<DatabaseStatus>;
}
