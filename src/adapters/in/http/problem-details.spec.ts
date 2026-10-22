import { describe, expect, it } from 'vitest';
import { buildProblem, codeForStatus, PROBLEM_CONTENT_TYPE } from './problem-details.js';

const TRACE = '3f0c9d58-8f6e-4f0a-9f0e-0d1d2a6b7c11';

describe('problem details (ADR 0019, RFC 9457)', () => {
  it('has its own media type', () => {
    expect(PROBLEM_CONTENT_TYPE).toBe('application/problem+json');
  });

  describe('codeForStatus', () => {
    it.each([
      [400, 'validation-failed'],
      [401, 'unauthenticated'],
      [403, 'forbidden'],
      [404, 'not-found'],
      [405, 'method-not-allowed'],
      [408, 'request-timeout'],
      [409, 'conflict'],
      [413, 'payload-too-large'],
      [415, 'unsupported-media-type'],
      [425, 'too-early'],
      [429, 'rate-limited'],
      [500, 'internal-error'],
      [502, 'service-unavailable'],
      [503, 'service-unavailable'],
      [504, 'service-unavailable'],
    ])('gives %i the stable code "%s"', (status, code) => {
      expect(codeForStatus(status)).toBe(code);
    });

    it('gives any other client error a generic code and any other server error a generic one', () => {
      expect(codeForStatus(418)).toBe('client-error');
      expect(codeForStatus(499)).toBe('client-error');
      expect(codeForStatus(501)).toBe('server-error');
      expect(codeForStatus(599)).toBe('server-error');
    });

    it('treats a status that is not an error as an internal error, never as success', () => {
      for (const status of [200, 302, 399, 600, 99, 404.5, Number.NaN]) {
        expect(codeForStatus(status), String(status)).toBe('internal-error');
      }
    });
  });

  describe('buildProblem', () => {
    it('fills the standard members and the extensions', () => {
      const problem = buildProblem({
        status: 404,
        detail: 'No existe el producto',
        instance: '/v1/products/abc',
        traceId: TRACE,
      });

      expect(problem).toEqual({
        type: 'urn:vsd-stock:problem:not-found',
        title: 'No encontrado',
        status: 404,
        detail: 'No existe el producto',
        instance: '/v1/products/abc',
        code: 'not-found',
        traceId: TRACE,
      });
    });

    it('lets a case use its own code and builds the type from it', () => {
      const problem = buildProblem({
        status: 409,
        code: 'shift-closed',
        detail: 'El turno ya estaba cerrado',
        instance: '/v1/sales',
        traceId: TRACE,
      });

      expect(problem.code).toBe('shift-closed');
      expect(problem.type).toBe('urn:vsd-stock:problem:shift-closed');
      expect(problem.title).toBe('Conflicto');
    });

    it('lists the invalid fields with a JSON pointer, a stable code and a detail', () => {
      const problem = buildProblem({
        status: 400,
        detail: 'Hay campos inválidos',
        instance: '/v1/sales',
        traceId: TRACE,
        errors: [
          { pointer: '/lines/0/quantityMilli', code: 'out-of-range', detail: 'Debe ser positivo' },
        ],
      });

      expect(problem.errors).toEqual([
        { pointer: '/lines/0/quantityMilli', code: 'out-of-range', detail: 'Debe ser positivo' },
      ]);
    });

    it('leaves out "errors" when there are none, instead of sending an empty list', () => {
      expect('errors' in buildProblem({ status: 400, instance: '/x', traceId: TRACE })).toBe(false);
      expect(
        'errors' in buildProblem({ status: 400, instance: '/x', traceId: TRACE, errors: [] }),
      ).toBe(false);
    });

    it('does not reveal the reason of a server error, whatever the caller passes', () => {
      const problem = buildProblem({
        status: 500,
        detail:
          'connect ECONNREFUSED 10.0.0.5:5432 (password authentication failed for user stock)',
        instance: '/v1/sales',
        traceId: TRACE,
      });

      expect(problem.detail).not.toContain('ECONNREFUSED');
      expect(problem.detail).not.toContain('password');
      expect(problem.detail).toContain('identificador');
      expect(problem.code).toBe('internal-error');
    });

    it('still lets a server error that is a known case say what it is (a 503 explains itself)', () => {
      const problem = buildProblem({
        status: 503,
        code: 'database-unavailable',
        instance: '/v1/sales',
        traceId: TRACE,
      });

      expect(problem.code).toBe('database-unavailable');
      expect(problem.title).toBe('Servicio no disponible');
    });

    it('uses the title of the status as the detail when nobody gives one', () => {
      expect(buildProblem({ status: 401, instance: '/x', traceId: TRACE }).detail).toBe(
        'Hace falta iniciar sesión',
      );
    });

    it('keeps the status inside the error range', () => {
      expect(buildProblem({ status: 200, instance: '/x', traceId: TRACE }).status).toBe(500);
    });

    it('never puts a query string in the instance, because it may carry data', () => {
      expect(
        buildProblem({ status: 404, instance: '/v1/customers?phone=3001234567', traceId: TRACE })
          .instance,
      ).toBe('/v1/customers');
    });

    it('never puts a fragment in the instance either', () => {
      expect(buildProblem({ status: 404, instance: '/v1/x#frag', traceId: TRACE }).instance).toBe(
        '/v1/x',
      );
    });
  });
});
