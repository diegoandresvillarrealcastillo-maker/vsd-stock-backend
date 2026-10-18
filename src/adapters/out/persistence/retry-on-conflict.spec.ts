import { describe, expect, it } from 'vitest';
import { isConflict, retryOnConflict } from './retry-on-conflict.js';

const conflict = (code = 'P2034') => Object.assign(new Error('conflicto'), { code });

describe('what counts as a conflict worth retrying', () => {
  it.each([
    ['Prisma «write conflict or deadlock»', conflict('P2034')],
    ['a serialization failure of PostgreSQL', Object.assign(new Error('x'), { code: '40001' })],
    ['a deadlock of PostgreSQL', Object.assign(new Error('x'), { code: '40P01' })],
    [
      'a serialization failure the driver adapter only names in the message',
      new Error('could not serialize access due to concurrent update (40001)'),
    ],
    ['a deadlock the driver adapter only names in the message', new Error('deadlock detected')],
    [
      'a conflict wrapped one level down, as the adapter does',
      Object.assign(new Error('wrapper'), { cause: conflict('40P01') }),
    ],
  ])('retries %s', (_name, error) => {
    expect(isConflict(error)).toBe(true);
  });

  it.each([
    ['a unique violation', conflict('P2002')],
    ['a plain error', new Error('boom')],
    ['a text', 'P2034'],
    ['nothing', undefined],
    ['null', null],
  ])('does not retry %s', (_name, error) => {
    expect(isConflict(error)).toBe(false);
  });

  it('does not loop forever on a cause that points to itself', () => {
    const loop: { cause?: unknown } = {};
    loop.cause = loop;

    expect(isConflict(loop)).toBe(false);
  });
});

describe('retrying work that lost against another transaction', () => {
  const noWait = () => Promise.resolve();

  it('returns what the work returns, running it once, when nothing conflicts', async () => {
    let runs = 0;

    const result = await retryOnConflict(() => {
      runs += 1;
      return Promise.resolve('listo');
    }, noWait);

    expect(result).toBe('listo');
    expect(runs).toBe(1);
  });

  it('runs the work again after a conflict and returns the result of the one that wins', async () => {
    let runs = 0;

    const result = await retryOnConflict(() => {
      runs += 1;
      return runs < 3 ? Promise.reject(conflict()) : Promise.resolve(`intento ${runs}`);
    }, noWait);

    expect(result).toBe('intento 3');
    expect(runs).toBe(3);
  });

  it('gives up after three attempts and throws the last conflict', async () => {
    let runs = 0;

    const failure = await retryOnConflict(() => {
      runs += 1;
      return Promise.reject(conflict());
    }, noWait).catch((error: unknown) => error);

    expect(runs).toBe(3);
    expect(failure).toMatchObject({ code: 'P2034' });
  });

  it('throws at once an error that is not a conflict', async () => {
    let runs = 0;

    const failure = await retryOnConflict(() => {
      runs += 1;
      return Promise.reject(new Error('boom'));
    }, noWait).catch((error: unknown) => error);

    expect(runs).toBe(1);
    expect(failure).toMatchObject({ message: 'boom' });
  });

  it('waits a little longer before every new attempt', async () => {
    const waits: number[] = [];
    let runs = 0;

    await retryOnConflict(
      () => {
        runs += 1;
        return runs < 3 ? Promise.reject(conflict()) : Promise.resolve('ok');
      },
      (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    );

    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeGreaterThan(0);
    expect(waits[1]).toBeGreaterThan(waits[0] as number);
    expect(waits.every((ms) => ms <= 200)).toBe(true);
  });
});
