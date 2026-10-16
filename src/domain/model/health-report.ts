/** Estado de salud del servicio en un instante. */
export interface HealthReport {
  readonly status: 'ok';
  /** Instante del informe en ISO 8601, en UTC. */
  readonly timestamp: string;
}

/**
 * Arma el informe de salud para el instante dado.
 * Lanza RangeError si la fecha no es valida: un informe con una hora sin
 * sentido es peor que ningun informe.
 */
export function createHealthReport(now: Date): HealthReport {
  return { status: 'ok', timestamp: now.toISOString() };
}
