/** Lo que se sabe de una operacion al reclamarla (ADR 0019). */
export interface OperationClaimRequest {
  readonly operationId: string;
  readonly kind: 'purchase' | 'adjustment';
  /** Quien la hace. */
  readonly userId: string;
  /** La huella del cuerpo: el mismo texto para la misma peticion. */
  readonly fingerprint: string;
}

/**
 * `claimed`: es nueva y ahora es nuestra, hay que aplicarla. `replay`: ya se aplico con este mismo cuerpo, no se
 * hace nada. `conflict`: el `operationId` existe con otro cuerpo u otra clase de operacion.
 */
export type OperationClaim = 'claimed' | 'replay' | 'conflict';

/**
 * Puerto de salida: el registro de operaciones idempotentes del negocio (ADR 0019). Reclamar y aplicar ocurren en la
 * MISMA transaccion: si lo que sigue falla, el reclamo se deshace con todo lo demas y la operacion puede reintentarse.
 */
export interface OperationRegistry {
  claim(request: OperationClaimRequest): Promise<OperationClaim>;
}
