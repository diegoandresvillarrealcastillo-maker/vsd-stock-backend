/**
 * Toda respuesta de la API lleva `Cache-Control: no-store` (ADR 0019). Una respuesta guardada por una cache dice lo
 * que fue verdad, no lo que es: un `/health` guardado diria que hay conexion cuando ya no la hay (ADR 0009), y una
 * existencia guardada venderia lo que ya no hay. El dispositivo tiene su propia copia de lectura, a proposito y
 * con su fecha; la cache del navegador no debe ser una segunda sin que nadie la gobierne.
 */
export function noStoreMiddleware(
  _req: unknown,
  res: { setHeader(name: string, value: string): unknown },
  next: () => void,
): void {
  res.setHeader('Cache-Control', 'no-store');
  next();
}
