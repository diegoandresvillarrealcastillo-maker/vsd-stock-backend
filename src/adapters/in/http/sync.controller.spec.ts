import { describe, expect, it } from 'vitest';
import { OperationIdReusedError } from '../../../domain/model/purchase-errors.js';
import { SaleVoidedError } from '../../../domain/model/sale-errors.js';
import { ShiftAlreadyOpenError } from '../../../domain/model/shift-errors.js';
import { ValidationFailedError } from '../../../domain/model/validation.js';
import type { Session } from '../../../domain/ports/in/authenticate.js';
import type { Sync, SyncCopy, SyncItemResult } from '../../../domain/ports/in/sync.js';
import { SyncController } from './sync.controller.js';

const OPERATION = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const NOW = new Date('2026-10-18T15:00:00.000Z');
const session = {} as Session;
const copy = {} as SyncCopy;

const applied = (
  kind: 'shift-open' | 'shift-close' | 'sale',
  replayed: boolean,
  value: unknown = { id: 'x' },
): SyncItemResult => ({
  operationId: OPERATION,
  kind,
  outcome: { type: 'applied', replayed, value },
});
const failed = (error: unknown, kind: SyncItemResult['kind'] = 'sale'): SyncItemResult => ({
  operationId: OPERATION,
  kind,
  outcome: { type: 'failed', error },
});

const run = async (results: SyncItemResult[], requestId?: string) => {
  const sync: Sync = { apply: () => Promise.resolve({ serverTime: NOW, results }) };
  const controller = new SyncController(sync, copy);
  const response = { locals: requestId === undefined ? {} : { requestId } };
  return await controller.apply(session, {}, response);
};

describe('SyncController: what each result says (ADR 0028)', () => {
  it('gives the time of the server and one result for each operation, in the same order', async () => {
    const reply = await run([applied('shift-open', false), applied('sale', false)]);

    expect(reply.serverTime).toEqual(NOW);
    expect(reply.results).toHaveLength(2);
  });

  it.each([
    ['shift-open', false, 201],
    ['shift-open', true, 200],
    ['sale', false, 201],
    ['sale', true, 200],
    ['shift-close', false, 200],
    ['shift-close', true, 200],
  ] as const)(
    'answers %s that was repeated=%s with the status of its own route: %i',
    async (kind, replayed, status) => {
      const [result] = (await run([applied(kind, replayed, { id: 'turno' })])).results;

      expect(result).toEqual({
        operationId: OPERATION,
        status,
        replayed,
        body: { id: 'turno' },
        problem: null,
      });
    },
  );

  it('turns an error of the domain into the problem that its route would have given, with its status', async () => {
    const [result] = (await run([failed(new ShiftAlreadyOpenError(), 'shift-open')], 'traza-1'))
      .results;

    expect(result).toMatchObject({
      operationId: OPERATION,
      status: 409,
      replayed: false,
      body: null,
      problem: {
        type: 'urn:vsd-stock:problem:shift-already-open',
        status: 409,
        code: 'shift-already-open',
        detail: 'Ya tienes un turno abierto en este dispositivo. Ciérralo antes de abrir otro.',
        instance: '/v1/sync',
        traceId: 'traza-1',
      },
    });
  });

  it('keeps the fields that did not work, the way a single route says them', async () => {
    const error = new ValidationFailedError([
      { pointer: '/lines/0/productId', code: 'unknown-product', detail: 'No existe.' },
    ]);

    const [result] = (await run([failed(error)])).results;

    expect(result?.status).toBe(400);
    expect(result?.problem?.code).toBe('validation-failed');
    expect(result?.problem?.errors).toEqual([
      { pointer: '/lines/0/productId', code: 'unknown-product', detail: 'No existe.' },
    ]);
  });

  it.each([
    [new SaleVoidedError(), 409, 'sale-voided'],
    [new OperationIdReusedError(), 409, 'operation-id-reused'],
  ])('says %s as %i %s', async (error, status, code) => {
    const [result] = (await run([failed(error)])).results;

    expect(result?.status).toBe(status);
    expect(result?.problem?.code).toBe(code);
  });

  it('says 500 for what nobody expected, without its cause, and the other operations go on', async () => {
    const reply = await run(
      [failed(new Error('password=secreto en la cadena')), applied('sale', false)],
      'traza-2',
    );

    const [broken, fine] = reply.results;
    expect(broken).toMatchObject({
      status: 500,
      problem: { status: 500, code: 'internal-error', traceId: 'traza-2' },
    });
    expect(JSON.stringify(broken)).not.toContain('secreto');
    expect(fine?.status).toBe(201);
  });

  it('gives a trace of its own when the request did not come with one', async () => {
    const [result] = (await run([failed(new ShiftAlreadyOpenError())])).results;

    expect(result?.problem?.traceId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('says which operation each result is for even when it could not be read', async () => {
    const reply = await run([
      {
        operationId: null,
        kind: null,
        outcome: { type: 'failed', error: new ValidationFailedError([]) },
      },
    ]);

    expect(reply.results[0]).toMatchObject({ operationId: null, status: 400 });
  });
});
