import { describe, expect, it } from 'vitest';
import { isUuid } from './uuid.js';

describe('isUuid', () => {
  it.each([
    '11111111-1111-4111-8111-111111111111',
    'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
    '9b2f6c1e-0d5a-4c1b-8f3e-2a7d6e5c4b3a',
  ])('accepts %s', (value) => {
    expect(isUuid(value)).toBe(true);
  });

  it.each([
    '',
    'no-es-un-uuid',
    '11111111-1111-4111-8111-11111111111',
    '11111111-1111-4111-8111-1111111111111',
    '11111111111141118111111111111111',
    '11111111-1111-4111-8111-11111111111g',
    ' 11111111-1111-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111\n',
    "11111111-1111-4111-8111-111111111111'; DROP TABLE app_user;--",
  ])('refuses %j', (value) => {
    expect(isUuid(value)).toBe(false);
  });

  it.each([undefined, null, 5, {}, ['11111111-1111-4111-8111-111111111111']])(
    'refuses %j, which is not text',
    (value) => {
      expect(isUuid(value)).toBe(false);
    },
  );
});
