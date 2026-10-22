# ADR 0027 — Registro de ventas y atención: se acepta siempre, lo raro se marca y alguien lo revisa

- **Estado:** Aceptada
- **Fecha:** 2026-10-19
- **Ciclo:** 3

## Contexto

El [ADR 0009](0009-motor-offline-y-libro-de-movimientos.md) decidió que una venta ya hecha en el mostrador **nunca se rechaza**,
y el [ADR 0013](0013-existencia-derivada-y-venta-como-una-sola-operacion.md) la escribió como una sola transacción. El
[ADR 0026](0026-turnos-de-caja-y-arqueo.md) dejó resuelta la venta que llega a un turno cerrado. Falta decir **qué contiene una
venta que llega del dispositivo, qué se acepta, qué se rechaza y qué se marca**, y cómo se ve y se corrige lo marcado: es el
contrato que el motor de sincronización del frontend (C3-09) y el punto de venta (C3-12) van a cumplir.

La venta es lo único que se hace con el cliente delante. Un teléfono sin conexión ya le dio el comprobante, con un folio
([ADR 0016](0016-folios-por-dispositivo-y-hora-corregida.md)), un precio y un total. El servidor llega después, sabe cosas que
el dispositivo no (la existencia de otras cajas, si el turno se cerró, si el dispositivo se dio de baja, el catálogo de hoy) y
no puede deshacer lo que ya pasó.

## Decisión

### Registrar (C3-03)

1. **Una venta es una sola operación idempotente** (`POST /v1/sales`, ADR 0019), con `operationId`, `shiftId`, `folio`, `total`
   (lo que el dispositivo le cobró al cliente), `lines`, `payments` y la hora del dispositivo (`deviceTime`, `clockOffsetMs`,
   ADR 0016). El identificador de la venta lo crea el servidor; el dispositivo la nombra por su `operationId` y su folio.
   Repetida con el mismo cuerpo responde `200` con la venta tal como quedó y `Idempotent-Replayed: true`; con otro, `409
operation-id-reused`. La diferencia del reloj no entra en la huella.
2. **Se acepta casi todo.** Lo único que se rechaza (siempre `400` con el campo que falla, y sin dejar nada hecho, ni siquiera el
   reclamo de la operación) es lo que ninguna realidad del mostrador explica: un cuerpo que no es una venta, un turno que no
   existe o **no es de quien vende** (los dos se dicen igual: `/shiftId` `unknown-shift`), un producto que el negocio no tiene
   (`/lines/N/productId` `unknown-product`) y una cantidad con decimales de un producto que se cuenta por unidades
   (`not-whole`). Un producto **archivado** después de que el dispositivo lo vendió se acepta.
3. **El servidor calcula el total otra vez**, con el mismo cálculo del ADR 0014, y guarda el suyo. **Respeta el precio y la
   tarifa con que se vendió** cada línea (el cliente pagó eso, aunque el catálogo ya haya cambiado) y la compara con el
   catálogo de hoy. El IVA se desglosa por tarifa al responder, siempre desde las líneas guardadas.
4. **Los cobros van sin el vuelto.** `amount` es lo que quedó en la caja o en la cuenta; el efectivo del turno es la suma de los
   cobros en efectivo (ADR 0026). Una venta de cero pesos no tiene cobros.
5. **Lo raro se marca, no se rechaza.** Cada marca tiene su lugar y su significado:

   | Marca                    | Dónde vive                        | Cuándo                                                            |
   | ------------------------ | --------------------------------- | ----------------------------------------------------------------- |
   | `needsAdjustment`        | `sale.needs_adjustment`           | Algún producto quedó con existencia **menor que cero** (ADR 0013) |
   | `folioConflict`          | `sale.folio_conflict`             | El folio ya era de otra venta (ADR 0016)                          |
   | `price-differs`          | `sale.flags`                      | Algún precio o tarifa vendidos no son los del catálogo de hoy     |
   | `total-differs`          | `sale.flags`                      | El total del dispositivo no es el que calculó el servidor         |
   | `payment-mismatch`       | `sale.flags`                      | Los cobros no suman el total del servidor                         |
   | `late-shift`             | `sale.flags`                      | La venta ocurrió **después** de que su turno se cerró (ADR 0026)  |
   | `revoked-device`         | `sale.flags`                      | La venta ocurrió después de que dieron de baja el dispositivo     |
   | `folio-device`           | `sale.flags`                      | El folio lleva el código de otro dispositivo, no el del turno     |
   | `clock-skew`, `stale`... | `operation.time_flags` (ADR 0016) | Lo raro de la hora                                                |

   `late-shift` y `revoked-device` miran la hora en que la venta **ocurrió**, no la de llegada: una venta hecha antes del cierre
   o de la baja y enviada después es una venta normal. La lista de marcas es cerrada y la base la hace cumplir
   (`sale_flags_known`); una marca nueva es una migración.

6. **El orden dentro de la transacción es fijo** (ADR 0013): validar y reclamar la operación → bajar la existencia (**un
   movimiento por producto**, en el orden de los identificadores, aunque haya varias líneas del mismo) → leer los saldos ya
   actualizados, bajo el candado de esas filas, para decidir `needsAdjustment` → **bloquear el turno en modo compartido y leer
   si se cerró** → escribir la venta, sus líneas y sus cobros. Si algo falla no queda nada, y el mismo `operationId` se puede
   reenviar.
7. **Un folio repetido no rechaza la venta.** Se guarda con `~` y los ocho primeros caracteres de su operación
   (`AA-000142~0a1b2c3d`), con `folioConflict` y el folio que trajo en `folioReported`. Se intenta con el folio tal cual, y si
   está tomado con el sufijo corto y, si hasta eso estuviera tomado, con la operación entera. `ON CONFLICT DO NOTHING` espera a
   la transacción que esté escribiendo ese mismo folio y decide con lo que deje, así que dos envíos a la vez no se pisan.
8. **Cualquier persona del negocio vende** (`sale:create`, todos los roles, también sin conexión), pero **solo en su propio
   turno**: el dispositivo de la venta es el del turno. Lo que una persona vende sin red lo envía ella misma, con su sesión.
9. **Las líneas y los cobros guardan su orden** (`position`): el comprobante que se vuelve a consultar es el que se entregó.

### Ver y atender (C3-04)

10. **Un cajero ve las ventas de sus turnos** (`sale:view-own-shift`); la gerencia, todas (`sale:view-all`, con conexión). La
    venta de otro turno no existe para un cajero (`404`), igual que una que nunca existió.
11. **«Requiere atención» es una bandeja, no un estado de la venta.** Entra a ella una venta **sin revisar** con `needsAdjustment`,
    `folioConflict`, cualquier marca de `sale.flags` o una marca de hora que de verdad pide mirar (`clock-skew`, `future`,
    `unreadable`; `clock-unverified` y `stale` informan pero no piden atención: un dispositivo que aún no mide su reloj es lo
    normal). La ve la gerencia.
12. **Revisar no borra nada.** Marcar una venta como revisada agrega una fila a una tabla de solo agregar (`sale_review`, quién y
    cuándo) y la saca de la bandeja; sus marcas siguen en la venta como historia. Revisar es de la gerencia y necesita conexión.

### Anular (C3-05)

13. **Anular no borra ni edita la venta** (ADR 0009): agrega una `sale_void` y los movimientos que compensan. Es de la gerencia
    (`sale:void`), necesita conexión y es idempotente por `operationId`. Una venta se anula una sola vez (`409 sale-voided`).
14. **La existencia vuelve** con un movimiento de motivo `void` por producto, en el orden fijo.
15. **El efectivo sale del turno abierto de quien anula, no del de la venta.** El turno de la venta puede estar cerrado y su
    arqueo firmado; la devolución se escribe como un egreso de efectivo (`cash_movement`) en un turno **abierto de quien anula**
    (`shiftId` en el cuerpo), con la venta y el folio en el motivo. Si la venta tuvo efectivo y quien anula no nombra un turno
    suyo abierto, `409 shift-required`: no se devuelve efectivo de una caja que nadie está contando. La venta anulada **sigue**
    sumada en el arqueo de su turno (ese efectivo sí entró) y la devolución se ve en el de quien anula.

## Alternativas consideradas

- **Rechazar la venta que el servidor encuentra rara** (sin existencia, precio distinto, turno cerrado): pierde una venta cuya
  mercancía ya salió y cuyo efectivo ya está en la caja. Descartada por el ADR 0009; aquí solo se rechaza lo que no es una venta.
- **Tomar el precio y la tarifa del catálogo de hoy:** el cliente pagó otra cosa, el total del comprobante dejaría de cuadrar y
  el efectivo del arqueo no sería el que entró. Se respeta lo vendido y se marca la diferencia.
- **Confiar en el total del dispositivo:** un error de redondeo o una versión vieja de la aplicación quedarían escondidos. Se
  calcula otra vez y se compara; la diferencia es información, no un rechazo.
- **Rechazar si los cobros no suman:** una venta con el vuelto mal restado es una venta, y el efectivo que sí quedó en la caja
  tiene que estar en el arqueo. Se acepta y se marca.
- **Que el dispositivo mande el vuelto y el efectivo recibido:** es un dato de la pantalla, no de la contabilidad; si se guarda
  hay que decidir qué hacer cuando no cuadra con los cobros. Los cobros ya van netos.
- **Guardar las marcas en una tabla aparte, una fila por marca:** más flexible, pero las marcas se consultan siempre junto con la
  venta y la lista es cerrada y corta. Un arreglo con una restricción que lo cierra basta y no necesita otro `JOIN`.
- **Un estado «requiere atención» en la venta que se cambia al revisar:** exige actualizar una tabla que el ADR 0013 dejó de solo
  agregar. La revisión es otra fila.
- **Devolver el efectivo desde el turno de la venta:** obliga a reabrir un turno cerrado o a cambiar un arqueo firmado. Se
  devuelve donde hay una caja abierta y alguien contando.
- **Un movimiento de stock por línea:** dos líneas del mismo producto abren dos escrituras al mismo saldo; uno por producto basta,
  es más corto y no cambia ninguna existencia.

## Consecuencias

### A favor

- **Ninguna venta hecha en el mostrador se pierde** por algo que el servidor sabía y el dispositivo no.
- **Todo lo raro queda visible y consultable** (las marcas, la hora cruda y la corregida, el folio que trajo), y la gerencia tiene
  una bandeja con lo que pide atención sin revisar la lista entera.
- **El total de una venta siempre se puede explicar:** sale de las líneas guardadas, con el precio con que se vendió.
- **La venta, la existencia y el efectivo no se descuadran:** o se escribe todo o nada, y reenviar es seguro también cuando se
  envía a la vez.
- **El folio que el cliente tiene en su comprobante no cambia nunca** (se conserva en `folioReported`).
- **No hace falta ninguna acción nueva** en el ADR 0017: `sale:create`, `sale:view-own-shift`, `sale:view-all` y `sale:void` ya existían.

### En contra

- **Una venta puede llevar varias marcas a la vez** y la gerencia tiene que decidir qué hacer con cada una; el sistema las dice,
  no las resuelve (por ejemplo, ajustar el inventario es otra operación, y la venta sigue marcada hasta que alguien la revise).
- **El servidor calcula el total con las reglas de hoy:** si el cálculo cambiara entre versiones, ventas viejas reenviadas
  quedarían con `total-differs`. Hay vectores de prueba compartidos con el frontend (`npm run vectors:check`) que lo vigilan.
- **`late-shift` y `revoked-device` dependen de la hora efectiva**, y la hora de un teléfono puede estar mal; las marcas de la
  hora de la operación (ADR 0016) lo hacen visible, pero no se corrige a ciegas.
- **Un candado compartido sobre el turno en cada venta** hace que cerrarlo espere a las ventas en curso (milisegundos).
- **Un cajero que vende en el turno de otra persona recibe `400`**, no una venta marcada: el dispositivo tiene que abrir el suyo.
  Es lo que se quiere (cada caja la cuenta quien la tiene), y el motor del frontend lo trata como un fallo que pide atención.
- **No hay devoluciones parciales** ni cambio de forma de pago: se anula la venta entera y se vuelve a vender.
- **La migración `20261019120000_ventas` hay que aplicarla a PRE** (y después a PROD) antes de desplegar este código, igual que
  la de turnos.
