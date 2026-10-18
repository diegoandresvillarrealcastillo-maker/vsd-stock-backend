/** Que sabemos de la base de datos: responde, no responde, o ni siquiera se configuro. */
export type DatabaseStatus = 'up' | 'down' | 'not-configured';

/**
 * Si el servicio puede atender peticiones de negocio. A diferencia de HealthReport (el proceso esta en pie), aqui
 * se comprueba lo que el servicio necesita para trabajar: hoy, la base de datos.
 */
export interface ReadinessReport {
  readonly status: 'ok' | 'unavailable';
  readonly database: DatabaseStatus;
  /** Instante del informe en ISO 8601, en UTC. */
  readonly timestamp: string;
}

/** Solo esta listo si la base responde. Lanza RangeError si la fecha no es valida. */
export function createReadinessReport(now: Date, database: DatabaseStatus): ReadinessReport {
  return {
    status: database === 'up' ? 'ok' : 'unavailable',
    database,
    timestamp: now.toISOString(),
  };
}
