import type { Clock } from '../../src/domain/ports/out/clock.js';
import type {
  GeneratedInvitation,
  InvitationCodes,
} from '../../src/domain/ports/out/invitation-codes.js';

export const NOW = new Date('2026-10-17T12:00:00.000Z');

export const fixedClock = (now: Date = NOW): Clock => ({ now: () => new Date(now) });

/** Codigos de mentira, uno distinto por llamada, y un «hash» que se reconoce a simple vista. */
export class FakeCodes implements InvitationCodes {
  private counter = 0;

  generate(): GeneratedInvitation {
    this.counter += 1;
    const code = `0123456789ABCD${String(this.counter).padStart(2, '0')}`;
    return { code, hash: this.hash(code) };
  }

  hash(code: string): string {
    return `hash:${code}`;
  }
}
