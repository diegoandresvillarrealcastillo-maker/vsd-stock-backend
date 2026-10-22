# ADR 0007 — Vitest, pruebas primero y cobertura mínima

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 0

## Contexto

En VSD Health adoptamos Vitest y trabajar con la prueba primero, y nos permitió cambiar mucho sin romper lo
anterior. VSD Stock maneja dinero e inventario: un error silencioso cuesta más aquí que allá.

## Decisión

- **Vitest** es el ejecutor de pruebas en los dos repositorios.
- **La prueba va primero.** Para cada ticket escribimos la prueba, la **vemos fallar por la razón correcta**
  y solo entonces escribimos el código mínimo que la hace pasar (dominio, aplicación y después adaptadores).
  El PR deja la evidencia: la salida de la ejecución en rojo y luego en verde.
- **Cobertura mínima del 80 %** en `domain/` y `application/`, con umbral configurado para que el CI falle si
  baja.
- **Pruebas en negativo para toda regla de autorización.** No basta con que el dueño acceda: otro negocio, un
  rol sin permiso y una petición sin sesión deben ser rechazados.
- **Integración contra PostgreSQL real**, no contra un simulado. En el CI usamos un contenedor efímero; en
  local, Docker. Las suites de integración **se ejecutan en serie**: en Health, en paralelo fallaban cerca de
  una de cada cuatro veces.
- En el frontend usamos Testing Library para los componentes y Vitest para el dominio y la aplicación.

## Alternativas consideradas

### Jest

Es lo que trae NestJS por defecto. Lo descartamos por la misma razón que en Health: Vitest comparte
configuración con Vite, es más rápido y soporta ESM sin trucos. Consecuencia: añadimos NestJS a mano, sin
`nest new`, para no arrastrar su configuración de Jest.

### `node:test`

Sin dependencias, pero con menos ecosistema (cobertura, simulación, navegador) para el frontend.

### Pruebas de integración con una base simulada

Más rápidas, pero no prueban RLS (ADR 0005), que es justo lo que más importa probar.

## Consecuencias

### A favor

- Cada regla importante tiene una prueba que se vio fallar, así que sabemos que la prueba prueba algo.
- El umbral de cobertura evita que el dominio se quede sin pruebas sin que nadie lo decida.

### En contra

- Escribir la prueba primero es más lento al principio, y el plazo es corto.
- El 80 % mide líneas ejecutadas, no calidad de las pruebas.
- Las suites contra PostgreSQL en serie alargan el CI.

### Mitigación acordada

Las pruebas en negativo y las de aislamiento no se negocian aunque falte tiempo. Si hay que recortar, se
recorta alcance funcional (ADR 0010), no pruebas.
