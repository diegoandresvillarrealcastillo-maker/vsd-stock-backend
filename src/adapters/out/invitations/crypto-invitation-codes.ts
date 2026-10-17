import { createHash, randomBytes } from 'node:crypto';
import { invitationCodeFromBytes } from '../../../domain/model/invitation-code.js';
import type {
  GeneratedInvitation,
  InvitationCodes,
} from '../../../domain/ports/out/invitation-codes.js';

/** Los bytes al azar de un codigo: ochenta bits (ADR 0023). */
const CODE_BYTES = 10;

/**
 * Adaptador de salida: el azar del sistema operativo y el SHA-256 de `node:crypto`. Un codigo de ochenta bits al azar no
 * necesita un hash lento ni sal: quien robara la base no puede adivinarlo, y la busqueda es por el hash (ADR 0023).
 */
export class CryptoInvitationCodes implements InvitationCodes {
  constructor(private readonly randomSource: (size: number) => Uint8Array = randomBytes) {}

  generate(): GeneratedInvitation {
    const code = invitationCodeFromBytes(this.randomSource(CODE_BYTES));
    return { code, hash: this.hash(code) };
  }

  hash(code: string): string {
    return createHash('sha256').update(code, 'utf8').digest('hex');
  }
}
