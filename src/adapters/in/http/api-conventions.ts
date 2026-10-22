import type { OpenAPIObject } from '@nestjs/swagger';

/**
 * Las convenciones de la API (ADR 0019) hechas comprobables. Recorre el contrato OpenAPI y devuelve una linea por
 * cada incumplimiento, con donde esta; una lista vacia es lo correcto. Hoy solo hay `GET /health`, pero la primera
 * ruta de negocio que rompa una regla hace fallar la prueba del contrato.
 */

const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

/** `/health` (sin version: es lo que mira el contenedor) o `/v1/...` en minusculas con guiones. */
const PATH = /^(?:\/health|\/v\d+(?:\/(?:[a-z0-9]+(?:-[a-z0-9]+)*|\{[a-z][A-Za-z0-9]*\}))*)$/;

/** Palabras que, dentro del nombre de un campo, lo vuelven dinero. */
const MONEY_WORDS = new Set([
  'price',
  'total',
  'subtotal',
  'amount',
  'tax',
  'discount',
  'cash',
  'cost',
]);

/** El unico `...Id` que no es un UUID: el identificador de seguimiento puede venir del cliente (ADR 0019). */
const NOT_UUID = new Set(['traceId']);

type Schema = { type?: string; format?: string; $ref?: string };

const words = (name: string): string[] => name.split(/(?=[A-Z])/).map((word) => word.toLowerCase());

function checkProperty(where: string, name: string, schema: Schema): string[] {
  if (schema.$ref !== undefined) return [];
  const found: string[] = [];
  const isInteger = schema.type === 'integer';
  const describe = `${where}.${name}`;

  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) {
    found.push(`${describe}: los nombres de los campos van en camelCase`);
  }
  if (words(name).some((word) => MONEY_WORDS.has(word)) && !isInteger) {
    found.push(`${describe}: el dinero es un integer de pesos, no ${schema.type ?? 'otra cosa'}`);
  }
  if (/(?:Milli|Bp)$/.test(name) && !isInteger) {
    found.push(
      `${describe}: las cantidades en milésimas y las tarifas en puntos básicos son integer`,
    );
  }
  if (
    (name === 'timestamp' || name.endsWith('At')) &&
    !(schema.type === 'string' && schema.format === 'date-time')
  ) {
    found.push(`${describe}: un instante es string con format date-time`);
  }
  if (
    (name === 'date' || name.endsWith('Date')) &&
    !(schema.type === 'string' && schema.format === 'date')
  ) {
    found.push(`${describe}: un día del negocio es string con format date`);
  }
  if (
    (name === 'id' || name.endsWith('Id')) &&
    !NOT_UUID.has(name) &&
    !(schema.type === 'string' && schema.format === 'uuid')
  ) {
    found.push(`${describe}: un identificador es string con format uuid`);
  }
  return found;
}

export function findConventionViolations(document: OpenAPIObject): string[] {
  const violations: string[] = [];

  for (const [path, item] of Object.entries(document.paths)) {
    if (!PATH.test(path)) {
      violations.push(
        `${path}: las rutas son /health o /v1/... en minúsculas con guiones (y sin barra final)`,
      );
    }
    for (const method of METHODS) {
      const operation = (item as Record<string, unknown>)[method] as
        { responses?: Record<string, unknown> } | undefined;
      if (operation === undefined) continue;
      const fallback = operation.responses?.['default'] as
        { content?: Record<string, { schema?: { $ref?: string } }> } | undefined;
      const reference = fallback?.content?.['application/problem+json']?.schema?.$ref;
      if (reference === undefined || !reference.endsWith('/ProblemDetailsDto')) {
        violations.push(
          `${method.toUpperCase()} ${path}: toda operación declara una respuesta default application/problem+json con ProblemDetailsDto`,
        );
      }
    }
  }

  for (const [name, schema] of Object.entries(document.components?.schemas ?? {})) {
    const properties = (schema as { properties?: Record<string, Schema> }).properties ?? {};
    for (const [property, definition] of Object.entries(properties)) {
      violations.push(...checkProperty(name, property, definition));
    }
  }
  return violations;
}
