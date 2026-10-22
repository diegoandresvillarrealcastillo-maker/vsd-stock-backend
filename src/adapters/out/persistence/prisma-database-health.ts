import type { DatabaseHealth, DatabaseStatus } from '../../../domain/ports/out/database-health.js';
import type { PrismaClient } from '../../../generated/prisma/client.js';

const DEFAULT_TIMEOUT_MS = 2_000;

/** Pregunta `SELECT 1`. Una base que tarda mas que el plazo cuenta como caida: nadie espera a una verificacion de salud. */
export class PrismaDatabaseHealth implements DatabaseHealth {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async check(): Promise<DatabaseStatus> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<'down'>((resolve) => {
      timer = setTimeout(() => resolve('down'), this.timeoutMs);
    });
    try {
      const answered = this.prisma.$queryRaw`SELECT 1`.then(
        () => 'up' as const,
        () => 'down' as const,
      );
      return await Promise.race([answered, expired]);
    } finally {
      clearTimeout(timer);
    }
  }
}
