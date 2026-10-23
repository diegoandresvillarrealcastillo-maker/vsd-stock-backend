import type { OpenAPIObject } from '@nestjs/swagger';
import { describe, expect, it } from 'vitest';
import { findConventionViolations } from './api-conventions.js';

// Las convenciones de la API (ADR 0019) hechas comprobables: se prueban sobre documentos de mentira que las
// rompen una por una, y despues sobre el contrato real. Cuando aparezca el primer endpoint de negocio, estas
// reglas empiezan a morder solas.

const PROBLEM_RESPONSE = {
  description: 'Error',
  content: {
    'application/problem+json': { schema: { $ref: '#/components/schemas/ProblemDetailsDto' } },
  },
};

function documentWith(
  paths: Record<string, unknown> = {},
  schemas: Record<string, unknown> = {},
): OpenAPIObject {
  return {
    openapi: '3.0.0',
    info: { title: 't', version: '1' },
    paths,
    components: { schemas },
  } as unknown as OpenAPIObject;
}

const operation = (overrides: Record<string, unknown> = {}) => ({
  get: {
    operationId: 'X_get',
    responses: { '200': { description: 'ok' }, default: PROBLEM_RESPONSE },
    ...overrides,
  },
});

const schemaWith = (properties: Record<string, unknown>) => ({
  S: { type: 'object', properties },
});

describe('API conventions (ADR 0019)', () => {
  it('finds nothing wrong in a document that follows them', () => {
    const document = documentWith(
      { '/health': operation(), '/v1/products': operation(), '/v1/sale-lines': operation() },
      schemaWith({
        id: { type: 'string', format: 'uuid' },
        operationId: { type: 'string', format: 'uuid' },
        unitPrice: { type: 'integer', format: 'int64' },
        quantityMilli: { type: 'integer' },
        rateBp: { type: 'integer' },
        occurredAt: { type: 'string', format: 'date-time' },
        businessDate: { type: 'string', format: 'date' },
        name: { type: 'string' },
      }),
    );

    expect(findConventionViolations(document)).toEqual([]);
  });

  describe('paths', () => {
    it('wants a version in every path, except /health', () => {
      const violations = findConventionViolations(
        documentWith({ '/products': operation(), '/health': operation() }),
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('/products');
      expect(violations[0]).toContain('/v1/');
    });

    it.each(['/v2/products', '/v10/products'])('accepts the version in %s', (path) => {
      expect(findConventionViolations(documentWith({ [path]: operation() }))).toEqual([]);
    });

    it.each([
      ['/V1/products', 'capital letters'],
      ['/v1/Products', 'capital letters in a segment'],
      ['/v1/sale_lines', 'an underscore'],
      ['/v1/saleLines', 'camel case'],
      ['/v1/products/', 'a trailing slash'],
    ])('wants lower-case kebab-case segments: rejects %s (%s)', (path) => {
      expect(
        findConventionViolations(documentWith({ [path]: operation() })).length,
      ).toBeGreaterThan(0);
    });

    it('accepts path parameters', () => {
      expect(
        findConventionViolations(documentWith({ '/v1/products/{productId}': operation() })),
      ).toEqual([]);
    });
  });

  describe('errors', () => {
    it('wants every operation to declare a default response that is a problem+json', () => {
      const violations = findConventionViolations(
        documentWith({
          '/v1/products': operation({ responses: { '200': { description: 'ok' } } }),
        }),
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('GET /v1/products');
      expect(violations[0]).toContain('problem+json');
    });

    it('rejects a default response that is plain JSON', () => {
      const plain = {
        description: 'Error',
        content: {
          'application/json': { schema: { $ref: '#/components/schemas/ProblemDetailsDto' } },
        },
      };

      expect(
        findConventionViolations(
          documentWith({ '/v1/products': operation({ responses: { default: plain } }) }),
        ),
      ).toHaveLength(1);
    });

    it('rejects a default response whose schema is not ProblemDetails', () => {
      const other = {
        description: 'Error',
        content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Other' } } },
      };

      expect(
        findConventionViolations(
          documentWith({ '/v1/products': operation({ responses: { default: other } }) }),
        ),
      ).toHaveLength(1);
    });

    it('checks every method of a path', () => {
      const path = {
        get: operation().get,
        post: { operationId: 'X_post', responses: { '201': { description: 'created' } } },
      };

      const violations = findConventionViolations(documentWith({ '/v1/products': path }));

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('POST /v1/products');
    });

    it.each(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'])(
      'checks the method %s',
      (method) => {
        const path = {
          [method]: { operationId: 'X', responses: { '200': { description: 'ok' } } },
        };

        const violations = findConventionViolations(documentWith({ '/v1/products': path }));

        expect(violations).toHaveLength(1);
        expect(violations[0]).toContain(`${method.toUpperCase()} /v1/products`);
      },
    );
  });

  describe('money, quantities and rates are integers', () => {
    it.each([
      'price',
      'unitPrice',
      'total',
      'subtotal',
      'amount',
      'tax',
      'taxBase',
      'discount',
      'cash',
    ])('rejects %s when it is not an integer', (name) => {
      const violations = findConventionViolations(
        documentWith({}, schemaWith({ [name]: { type: 'number', format: 'double' } })),
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(name);
      expect(violations[0]).toContain('integer');
    });

    it('rejects money sent as a string', () => {
      expect(
        findConventionViolations(documentWith({}, schemaWith({ total: { type: 'string' } }))),
      ).toHaveLength(1);
    });

    it.each(['taxKind', 'priceKind'])(
      'lets %s be a string: a field that ends in «Kind» names a classification, not an amount (ADR 0034)',
      (name) => {
        const kind = { type: 'string', enum: ['taxed', 'exempt', 'excluded'] };

        expect(findConventionViolations(documentWith({}, schemaWith({ [name]: kind })))).toEqual(
          [],
        );
      },
    );

    it('still wants an amount to be an integer when «kind» is not its last word', () => {
      expect(
        findConventionViolations(documentWith({}, schemaWith({ kindTotal: { type: 'string' } }))),
      ).toHaveLength(1);
    });

    it.each(['quantityMilli', 'stockMilli', 'rateBp', 'percentBp'])(
      'wants %s to be an integer',
      (name) => {
        expect(
          findConventionViolations(documentWith({}, schemaWith({ [name]: { type: 'number' } }))),
        ).toHaveLength(1);
      },
    );
  });

  describe('instants, days and identifiers', () => {
    it.each(['occurredAt', 'receivedAt', 'createdAt', 'timestamp'])(
      'wants %s to be a date-time',
      (name) => {
        const violations = findConventionViolations(
          documentWith({}, schemaWith({ [name]: { type: 'string' } })),
        );

        expect(violations).toHaveLength(1);
        expect(violations[0]).toContain('date-time');
      },
    );

    it('wants a business day to be a date', () => {
      expect(
        findConventionViolations(
          documentWith({}, schemaWith({ businessDate: { type: 'string' } })),
        ),
      ).toHaveLength(1);
      expect(
        findConventionViolations(
          documentWith({}, schemaWith({ businessDate: { type: 'string', format: 'date-time' } })),
        ),
      ).toHaveLength(1);
    });

    it.each(['id', 'productId', 'operationId', 'shiftId'])('wants %s to be a uuid', (name) => {
      const violations = findConventionViolations(
        documentWith({}, schemaWith({ [name]: { type: 'string' } })),
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('uuid');
    });

    it('does not ask a uuid of a field that merely ends in "id" inside another word', () => {
      expect(
        findConventionViolations(documentWith({}, schemaWith({ valid: { type: 'boolean' } }))),
      ).toEqual([]);
    });
  });

  describe('names', () => {
    it.each(['Total', 'unit_price', 'unit-price', '1st'])('wants camelCase: rejects %s', (name) => {
      expect(
        findConventionViolations(documentWith({}, schemaWith({ [name]: { type: 'string' } })))
          .length,
      ).toBeGreaterThan(0);
    });
  });

  it('describes where the violation is, so that whoever breaks a convention knows what to fix', () => {
    const violations = findConventionViolations(
      documentWith({}, { SaleDto: { type: 'object', properties: { total: { type: 'string' } } } }),
    );

    expect(violations[0]).toContain('SaleDto.total');
  });

  it('tolerates a document with no components', () => {
    expect(
      findConventionViolations({ openapi: '3.0.0', info: { title: 't', version: '1' }, paths: {} }),
    ).toEqual([]);
  });
});
