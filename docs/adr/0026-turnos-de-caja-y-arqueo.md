# ADR 0026 — Turnos de caja y arqueo: quién abre, qué pasa con una venta tardía y cómo se cuenta el efectivo

- **Estado:** Aceptada
- **Fecha:** 2026-10-18
- **Ciclo:** 3

## Contexto

El [ADR 0009](0009-motor-offline-y-libro-de-movimientos.md) decidió que una venta ya hecha en el mostrador **nunca se
rechaza**: se acepta y, si algo no cuadra, se marca. El [ADR 0013](0013-existencia-derivada-y-venta-como-una-sola-operacion.md)
escribió la venta como una sola transacción y, para probarlo, construyó un turno cerrado que **rechazaba** la venta. Los dos
se contradicen: ¿qué pasa con una venta que llega a un turno que alguien ya cerró? Pasa de verdad: un administrador cierra el
turno de una persona desde su navegador mientras el teléfono de ella sigue vendiendo sin red.

El [ADR 0016](0016-folios-por-dispositivo-y-hora-corregida.md) dio a cada operación una hora efectiva corregida, el
[ADR 0017](0017-roles-permisos-y-modo-sin-conexion.md) dejó las acciones `shift:open`, `shift:close`, `shift:close-other` y
`cash-movement:create`, y el [ADR 0019](0019-convenciones-de-la-api.md) fijó la idempotencia por `operationId`. Las tablas
`cash_shift`, `cash_movement` y `operation` (con sus clases `shift_open`, `shift_close` y `cash_movement`) existen desde el
[ADR 0021](0021-esquema-real-y-primera-migracion.md). Faltaba decidir las reglas.

## Decisión

1. **Un turno abierto por dispositivo y por persona.** Dos personas pueden turnarse un dispositivo (cada una con el suyo
   abierto); una persona no abre dos turnos en el mismo dispositivo ni abre uno en un dispositivo mientras tiene otro abierto
   en él. Lo impone la base con un índice único parcial (`cash_shift_one_open`, solo donde `closed_at IS NULL`), así que ni dos
   peticiones a la vez la rompen. Abrir otro es `409 shift-already-open`.
2. **El identificador del turno lo crea el dispositivo.** Para poder vender sin haber hablado con el servidor, el dispositivo se
   inventa el UUID del turno (como el del dispositivo, ADR 0016) y lo manda al abrirlo. Un identificador que ya es de otro turno
   —también de otro negocio, la llave primaria es global— es `409 shift-id-reused`.
3. **Abrir y cerrar son operaciones idempotentes** (`POST /v1/shifts`, `POST /v1/shifts/{id}/close`) con su `operationId`, que
   un dispositivo puede mandar sin conexión y en el mismo lote que sus ventas, **en orden** (ADR 0028). Repetirlas con el mismo
   cuerpo responde `200` con el turno **tal como está ahora** (no como estaba al responder la primera vez) y
   `Idempotent-Replayed: true`; con otro cuerpo, `409 operation-id-reused`. Cerrar un turno ya cerrado con otra operación es
   `409 shift-closed`.
4. **Toda operación del dispositivo lleva su hora** (`deviceTime`, y `clockOffsetMs` si se midió; ADR 0016). El servidor
   resuelve la hora efectiva, guarda la cruda y las marcas en `operation`, y **nunca rechaza** por la hora: una que no se puede
   leer se acepta con la hora de llegada y la marca `unreadable`. La diferencia del reloj **no** entra en la huella de
   idempotencia: el dispositivo la mide de nuevo en cada intento y un reintento sigue siendo el mismo cuerpo.
5. **Quién cierra:** la persona del turno (`shift:close`) o la gerencia, con conexión (`shift:close-other`). El cierre pone **de
   una vez** la hora, el efectivo contado y quién lo cerró (lo impone un `CHECK` de la base: un turno está abierto o cerrado
   del todo) y no puede ser anterior a la apertura: un reloj que se fue hacia atrás cierra en el instante en que se abrió.
6. **El arqueo se calcula al consultar, no se guarda.** `esperado = efectivo inicial + efectivo cobrado en las ventas del turno
   - entradas de efectivo − salidas`; `diferencia = contado − esperado` (negativo falta, positivo sobra). El efectivo de una
     venta es la suma de sus cobros en efectivo: la tarjeta y la transferencia no están en la caja. Se calcula al consultar
     porque lo que llega después de cerrar (una venta hecha antes del cierre en un teléfono sin red) cambia lo esperado, y el
     número que sirve es el de ahora.
7. **Una venta que llega a un turno ya cerrado se acepta** (se resuelve a favor del ADR 0009; el ADR 0013 solo probó que la base
   puede rechazarla, no que deba). Si su hora efectiva es **posterior al cierre**, es una **venta tardía**: queda en ese turno,
   se marca (C3-03) y el arqueo la muestra **aparte** (`lateSales`: cuántas y cuánto efectivo) **sin sumarla a lo esperado**,
   porque la persona contó la caja antes de que llegara. Una venta hecha antes del cierre que solo llegó después **no** es
   tardía: entra en lo esperado y por eso el arqueo cambia al consultarlo de nuevo.
8. **Mover efectivo fuera de una venta** (`POST /v1/cash-movements`) es de la gerencia y necesita conexión
   (`cash-movement:create`): entra o sale efectivo de un turno **abierto**, con un motivo **obligatorio** (un movimiento sin
   motivo es un hueco en la caja) y como operación idempotente. El efectivo de un turno cerrado no se toca: su arqueo ya se
   hizo (`409 shift-closed`).
9. **Quién ve qué:** la gerencia ve todos los turnos (`sale:view-all`); un cajero solo los suyos, y el turno de otra persona
   **no existe** para él (`404`, igual que uno que nunca existió). No se agrega una acción nueva a la tabla del ADR 0017.
10. **Una migración** (`20261018120000_turnos`): la columna `closed_by_user_id` (con su clave foránea compuesta), el `CHECK` de
    cierre completo y el índice parcial. Una persona la aplica a PRE; el script `preparar-pre.ps1` lo hace.

## Alternativas consideradas

- **Rechazar la venta que llega a un turno cerrado** (lo que probó el ADR 0013): contradice el ADR 0009 y pierde una venta que
  ya ocurrió y cuyo efectivo ya está en la caja. Descartada.
- **Reabrir el turno cuando llega una venta tardía:** deshace un arqueo que alguien ya firmó y esconde la diferencia que de
  verdad hubo al contar. Descartada.
- **Sumar las ventas tardías a lo esperado:** el arqueo «cuadraría» sin que la persona hubiera contado ese efectivo.
  Descartada: se muestran aparte y quien revisa decide.
- **Guardar lo esperado al cerrar:** congela un número que la llegada de ventas hechas antes del cierre vuelve falso.
- **Un turno por dispositivo (sin la persona):** dos cajeras que se turnan un teléfono no pueden tener cada una el suyo abierto,
  y el cambio de turno con el internet caído se vuelve imposible.
- **Que el servidor cree el identificador del turno:** obliga a hablar con el servidor para abrir la caja, que es justo lo que
  hay que poder hacer sin red.
- **Comparar la llegada con el cierre para decir «tardía»** (el orden en que el servidor se enteró): un teléfono que cierra su
  propio turno sin red y sincroniza todo junto parecería tardío. La hora efectiva dice cuándo ocurrió de verdad.

## Consecuencias

### A favor

- **Una venta ya hecha nunca se pierde**, ni siquiera si llega a un turno que alguien cerró: queda en su turno, marcada, y el
  efectivo que cobró se ve en el arqueo.
- **La caja no se abre dos veces por descuido:** la base lo impide, aunque dos peticiones lleguen a la vez.
- **Abrir la caja no necesita al servidor:** el identificador del turno lo crea el dispositivo, y abrir y cerrar son
  operaciones que viajan con las ventas, en orden.
- **El arqueo cuenta lo que hay, no un número congelado:** una venta hecha antes del cierre que llega después se suma donde
  corresponde.
- **No se agrega ninguna acción a la tabla de permisos** del ADR 0017.

### En contra

- **El arqueo de un turno cerrado puede cambiar al consultarlo de nuevo**, porque una venta anterior al cierre puede llegar
  después. Es lo correcto (el efectivo está en la caja), pero quien imprima un arqueo debe mostrarlo con la hora de la
  consulta. Las ventas tardías, en cambio, nunca lo cambian.
- **La hora efectiva decide qué es tardío**, y la hora de un teléfono puede estar mal. Una venta con un reloj atrasado podría
  verse tardía o no serlo. Las marcas de la operación (`clock-skew`, `clock-unverified`) lo hacen visible; no se corrige a ciegas.
- **Una persona con el turno abierto en un dispositivo que se perdió** no puede abrir otro en él hasta que la gerencia lo cierre
  (`shift:close-other`). Es la contrapartida del índice parcial y es lo que se quiere: no hay dos cajas abiertas a su nombre.
- **Cerrar espera a las ventas en curso** (el `UPDATE` del cierre toma la fila que las ventas tienen bloqueada en modo
  compartido, ADR 0013): un cierre puede tardar lo que tarde la venta más lenta, que son milisegundos.
- **Una anulación devuelve el efectivo desde el turno abierto de quien anula** (C3-05), no desde el de la venta: el arqueo del
  turno original no cambia retroactivamente, pero la devolución se ve en otro turno y quien revisa tiene que seguirla.
- **Hace falta aplicar una migración a PRE** (y después a PROD) antes de desplegar este código.
