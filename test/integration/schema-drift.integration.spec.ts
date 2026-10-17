import { describe, expect, it } from 'vitest';
import { diffSchema, ownerUrlOf } from '../../scripts/prepare-database.ts';

/**
 * El modelo vive en dos descripciones: prisma/schema.prisma (lo que usa el codigo) y el SQL de las migraciones
 * (lo que existe en la base). Si una cambia sin la otra, el codigo y la base se contradicen sin avisar (ADR 0021).
 * Esta prueba aplica las migraciones y compara: cualquier diferencia la rompe, y dice cual es.
 */
describe('prisma/schema.prisma against the migrated database (ADR 0021)', () => {
  it('say the same thing', () => {
    const url = process.env['TEST_DATABASE_URL']!;

    const result = diffSchema(ownerUrlOf(url));

    expect(result.output).toBe('');
    expect(result.identical).toBe(true);
  });
});
