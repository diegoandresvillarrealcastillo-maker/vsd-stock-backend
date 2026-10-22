import { describe, expect, it } from 'vitest';
import type { Clock } from '../../domain/ports/out/clock.js';
import { GetHealthUseCase } from './get-health.usecase.js';

// Doble de prueba: devuelve los instantes en el orden en que se le pidieron.
class SequenceClock implements Clock {
  private index = 0;

  constructor(private readonly instants: readonly Date[]) {}

  now(): Date {
    const instant = this.instants[this.index];
    if (instant === undefined) {
      throw new Error('SequenceClock ran out of instants');
    }
    this.index += 1;
    return instant;
  }
}

describe('GetHealthUseCase', () => {
  it('builds the report from the instant the clock gives', () => {
    const useCase = new GetHealthUseCase(new SequenceClock([new Date('2026-10-16T15:30:00.000Z')]));

    expect(useCase.execute()).toEqual({ status: 'ok', timestamp: '2026-10-16T15:30:00.000Z' });
  });

  it('asks the clock on every call, so two calls can report different instants', () => {
    const useCase = new GetHealthUseCase(
      new SequenceClock([
        new Date('2026-10-16T15:30:00.000Z'),
        new Date('2026-10-16T15:30:05.000Z'),
      ]),
    );

    expect(useCase.execute().timestamp).toBe('2026-10-16T15:30:00.000Z');
    expect(useCase.execute().timestamp).toBe('2026-10-16T15:30:05.000Z');
  });
});
