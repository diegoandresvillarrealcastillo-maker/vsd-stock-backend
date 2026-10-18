import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  pageOf,
  readPageRequest,
} from './pagination.js';
import { InputReader, ValidationFailedError, type FieldError } from './validation.js';

const read = (query: unknown, arity = 2) => {
  const reader = new InputReader(query, ['limit', 'cursor']);
  const request = readPageRequest(reader, arity);
  reader.finish();
  return request;
};

const errorsOf = (query: unknown): FieldError[] => {
  try {
    read(query);
    return [];
  } catch (error) {
    if (error instanceof ValidationFailedError) return [...error.errors];
    throw error;
  }
};

describe('the cursor', () => {
  it('is opaque text that hands back the position it was made from', () => {
    const cursor = encodeCursor(['Ana Gómez', '33333333-3333-4333-8333-333333333333']);

    expect(decodeCursor(cursor, 2)).toEqual(['Ana Gómez', '33333333-3333-4333-8333-333333333333']);
  });

  it('survives any character a name can have, and travels in a URL without escaping', () => {
    const parts = ['Ñandú "el/grande" ?&=+ 😀', 'x'];
    const cursor = encodeCursor(parts);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor, 2)).toEqual(parts);
  });

  it.each([
    ['not base64', '%%%'],
    ['empty', ''],
    ['base64 of something that is not JSON', Buffer.from('hola').toString('base64url')],
    ['JSON that is not a list', Buffer.from('{"a":1}').toString('base64url')],
    ['a list of other things', Buffer.from('[1,2]').toString('base64url')],
    ['a list of the wrong size', encodeCursor(['solo uno'])],
    ['a very long text', 'A'.repeat(5000)],
  ])('refuses %s', (_label, cursor) => {
    expect(decodeCursor(cursor, 2)).toBeUndefined();
  });
});

describe('the request for a page', () => {
  it('defaults to fifty from the beginning', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(50);
    expect(MAX_PAGE_SIZE).toBe(200);
    expect(read({})).toEqual({ limit: 50, after: undefined });
  });

  it.each([
    ['1', 1],
    ['50', 50],
    ['200', 200],
  ])('accepts a limit of %s', (text, limit) => {
    expect(read({ limit: text }).limit).toBe(limit);
  });

  it.each(['0', '201', '99999'])('refuses a limit of %s, outside 1 to 200', (text) => {
    expect(errorsOf({ limit: text })).toEqual([
      { pointer: '/limit', code: 'out-of-range', detail: 'El límite debe estar entre 1 y 200.' },
    ]);
  });

  it.each(['abc', '1.5', '-1', ' 5', '', '5 ', '1e2', '0x10', '00000000005', ['5', '6']])(
    'refuses a limit of %j, which is not a whole number',
    (value) => {
      expect(errorsOf({ limit: value })).toEqual([
        { pointer: '/limit', code: 'invalid-type', detail: 'El límite debe ser un número entero.' },
      ]);
    },
  );

  it('hands over the position a cursor stands for', () => {
    const cursor = encodeCursor(['Ana', 'id-1']);

    expect(read({ cursor })).toEqual({ limit: 50, after: ['Ana', 'id-1'] });
  });

  it.each([
    'basura',
    '',
    ['a', 'b'],
    [encodeCursor(['Ana', 'id-1'])],
    encodeCursor(['una sola parte']),
  ])('refuses the cursor %j without saying what is inside a good one', (cursor) => {
    expect(errorsOf({ cursor })).toEqual([
      {
        pointer: '/cursor',
        code: 'invalid-cursor',
        detail: 'El cursor no es válido. Pide la lista desde el principio.',
      },
    ]);
  });

  it('reports a bad limit and a bad cursor together', () => {
    expect(errorsOf({ limit: '0', cursor: 'basura' }).map((e) => e.pointer)).toEqual([
      '/limit',
      '/cursor',
    ]);
  });

  it('refuses a query parameter it does not know', () => {
    expect(errorsOf({ pagina: '2' })[0]).toMatchObject({
      pointer: '/pagina',
      code: 'unknown-field',
    });
  });
});

describe('cutting a page out of the rows read', () => {
  const rows = ['a', 'b', 'c', 'd'];
  const cursorOf = (row: string) => [row, `id-${row}`];

  it('is the last page, with no cursor, when the rows fit', () => {
    expect(pageOf(rows.slice(0, 3), 3, cursorOf)).toEqual({
      items: ['a', 'b', 'c'],
      nextCursor: null,
    });
    expect(pageOf([], 3, cursorOf)).toEqual({ items: [], nextCursor: null });
  });

  it('keeps `limit` rows and points at where the next page starts when one more row was read', () => {
    const page = pageOf(rows, 3, cursorOf);

    expect(page.items).toEqual(['a', 'b', 'c']);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor ?? '', 2)).toEqual(['c', 'id-c']);
  });
});
