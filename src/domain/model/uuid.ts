const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Si es un UUID escrito en su forma de ocho-cuatro-cuatro-cuatro-doce. Lo que llega por una URL se mira con esto antes
 * de preguntarle algo a la base: un identificador que no lo es no es de nadie, y asi la respuesta es «no existe» y no
 * un error de la base.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
