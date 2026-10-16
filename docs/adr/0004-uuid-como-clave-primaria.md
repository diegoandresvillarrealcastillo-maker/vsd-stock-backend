# ADR 0004 — UUID como clave primaria

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 0

## Contexto

El punto de venta debe poder registrar una venta sin conexión. Eso significa que el dispositivo necesita
identificar una venta, sus líneas, sus movimientos de stock y la operación que los envía **antes** de hablar
con el servidor. Con identificadores autoincrementales, dos cajas sin conexión asignarían los mismos
números y chocarían al sincronizar. Además, los números consecutivos son enumerables desde una URL.

## Decisión

**Todas las claves primarias y foráneas son UUID.**

- Lo que se crea en el dispositivo (venta, líneas, movimientos, operación) se identifica con un UUID
  **generado en el cliente** con `crypto.randomUUID()` (versión 4).
- El servidor genera los suyos con `gen_random_uuid()`.
- El **`operationId`** es un UUID que se crea una sola vez por operación y no cambia al reenviarla. El
  servidor lo usa como clave de idempotencia por negocio (ADR 0009).
- Un identificador recibido del cliente es un dato no confiable: el servidor valida su formato y nunca
  confía en que sea único por sí solo.

## Alternativas consideradas

### Enteros autoincrementales

Más compactos y rápidos, pero se asignan en el servidor: no sirven para trabajar sin conexión y son
enumerables.

### UUID versión 7

Ordenable por tiempo y más amable con los índices. Lo descartamos por ahora porque las versiones de
PostgreSQL anteriores a la 18 no lo generan de forma nativa y la escala de una MiPyme no justifica la
complejidad. Si los índices llegaran a ser un problema, lo reevaluamos con un ADR nuevo.

### Un identificador compuesto por dispositivo y contador

Evita colisiones, pero obliga a registrar dispositivos y a coordinar series, y expone cuántas ventas hace
un negocio.

## Consecuencias

### A favor

- Las ventas offline se identifican sin coordinación y la sincronización no genera colisiones.
- Los identificadores no revelan cuántas ventas tiene un negocio.

### En contra

- Los UUID versión 4 ocupan más espacio y no tienen orden: los índices se fragmentan más. Con el volumen de
  una MiPyme no lo esperamos como problema, y lo mediremos en el Ciclo 4.
- **Un cliente podría enviar un identificador que ya existe en otro negocio.** Si la clave primaria fuera solo
  el UUID, el conflicto revelaría que ese identificador existe en otro lado.

### Mitigación acordada

En el Ciclo 1, al diseñar el modelo de datos, decidimos si las tablas con identificadores creados por el
cliente usan clave primaria compuesta `(id_negocio, id)`, de modo que un identificador repetido en otro
negocio no revele nada. La decisión se registra en el ADR del modelo de datos.
