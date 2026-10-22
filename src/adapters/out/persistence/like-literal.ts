/**
 * Prisma no escapa los comodines de LIKE: buscar «100%» o «A_R» sin esto compararia con «cualquier cosa». Con la barra
 * invertida, que es el escape por omision de PostgreSQL, se buscan como los caracteres que son.
 */
export function literal(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}
