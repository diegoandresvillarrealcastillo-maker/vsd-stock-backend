# ADR 0009 — Motor offline-first y libro de movimientos

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 0

## Contexto

Un negocio real debe poder **vender aunque se caiga el internet**. Eso significa que el punto de venta registra
ventas y mueve inventario en el dispositivo y las envía después, y que dos cajas pueden vender lo mismo sin
verse. En VSD Health resolvimos algo parecido para el diario (ADR 0019 y 0020 de ese proyecto); aquí el
problema es más delicado porque hay dinero y existencias de por medio.

Este ADR fija los **principios**. El diseño detallado se escribe en el Ciclo 1 y no se implementa nada hasta
que se apruebe.

## Decisión

1. **IndexedDB con `idb`, una base por persona y dispositivo**, nombrada con el identificador de la sesión.
   Olvidar a alguien es un solo `deleteDB`.
2. Se guardan **dos cosas**: copias de lectura (catálogo, existencias, precios, clientes) y la **cola de
   operaciones** (lo que se hizo y falta enviar).
3. **Cada operación lleva un `operationId`** (UUID, ADR 0004) creado una vez. El servidor lo usa como clave de
   idempotencia **por negocio**: reenviar tras perder la respuesta devuelve lo que ya existe y no crea nada
   dos veces. El orden se respeta solo sobre **una misma cosa**.
4. **El inventario es un libro de movimientos, no un número.** El stock no se sobrescribe: cada venta, compra,
   ajuste o devolución genera un **movimiento inmutable** (`+` o `−`, con motivo) y la existencia es la suma.
   Corregir es agregar un movimiento que compensa; anular una venta, también. Nunca se edita.
5. **Una venta ya hecha en el mostrador nunca se rechaza al sincronizar**, porque la mercancía ya salió. Si la
   suma deja el stock negativo, el servidor **acepta, marca «requiere ajuste» y avisa al dueño o al
   administrador** (no al cajero). Solo se rechaza lo inválido de verdad: negocio distinto, firma inválida o
   forma ilegible.
6. **Los fallos se clasifican**:

   | Clase     | Ejemplos                              | Qué se hace                                           |
   | --------- | ------------------------------------- | ----------------------------------------------------- |
   | Red       | `fetch` falla, respuesta que no es JSON | Se detiene todo; no gasta un intento                |
   | Sesión    | 401                                   | Se detiene todo; **la cola se conserva**              |
   | Pasajero  | 408, 425, 429, 5xx                    | Espera creciente con azar; respeta `Retry-After`      |
   | Conflicto | 409                                   | Se marca; no se pisa nada; se muestra a la persona    |
   | Permanente| Otros 4xx                             | Se marca para atención; no bloquea a las demás        |

7. **Una sola sincronización a la vez** entre pestañas (Web Locks). **La conexión se confirma con
   `GET /health`**; `navigator.onLine` es solo una pista.
8. **Estados visibles y honestos:** en línea, sin conexión, sincronizando, N pendientes y requiere atención.
   Nunca se dice «guardado» si solo está en el dispositivo.

### Queda para el Ciclo 1

El cifrado local (AES-GCM, clave no extraíble y qué amenaza cubre y cuál no), la hora de una operación sin
conexión, la numeración de folios sin colisiones, la tabla de qué se puede y qué no se puede hacer sin red, y
cuándo se olvida lo guardado.

## Alternativas consideradas

### Guardar el número de existencias y sobrescribirlo

Es lo más simple, pero con dos cajas sin conexión gana la última que escribe y se pierden ventas. Es el error
que el libro de movimientos evita.

### Rechazar la venta que deja el stock negativo

La mercancía ya salió del mostrador; rechazarla deja la venta sin registrar y la caja descuadrada.

### Contadores sin conflicto (CRDT)

El libro de movimientos ya es un contador que se suma sin conflicto y además es auditable. Un CRDT añade
complejidad sin ganancia.

### Depender solo de Background Sync

No está disponible en todos los navegadores, y la sincronización debe poder dispararse también desde la propia
aplicación.

## Consecuencias

### A favor

- Dos cajas que venden lo mismo sin conexión **no se pisan**: se suman.
- Todo queda auditado: las ventas, anulaciones y ajustes son inmutables.
- Reenviar nunca duplica.

### En contra

- **La existencia es una suma**, y calcularla en cada lectura puede ser lento. Habrá que mantener un saldo
  derivado, calculado en la misma transacción que el movimiento (se diseña en el Ciclo 1).
- Puede haber stock negativo, y alguien tiene que atender los casos «requiere ajuste».
- Los datos de un negocio quedan en un equipo que puede ser compartido.
- Probar el comportamiento sin conexión exige un navegador real, no solo pruebas unitarias.

### Mitigación acordada

- El cifrado local y la política de olvido se diseñan en el Ciclo 1 **con su alcance honesto**: protegen un
  equipo compartido con la sesión cerrada, no frente a un ataque de scripts en la propia página.
- Antes de cerrar sesión con ventas sin enviar se avisa a la persona.
