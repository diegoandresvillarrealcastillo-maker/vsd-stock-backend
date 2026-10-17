export interface GeneratedInvitation {
  /** El codigo canonico, para mostrarlo UNA vez. */
  readonly code: string;
  /** Lo unico que se guarda: el SHA-256 del codigo. */
  readonly hash: string;
}

/** Puerto de salida: el azar y el hash de los codigos de invitacion (ADR 0023). */
export interface InvitationCodes {
  generate(): GeneratedInvitation;
  /** El hash de un codigo canonico, el mismo que se guardo al generarlo. */
  hash(code: string): string;
}
