# Convenciones de la API

Cómo habla la API de VSD Stock, para quien escribe un endpoint y para quien lo consume. La decisión y sus razones
están en el [ADR 0019](adr/0019-convenciones-de-la-api.md); aquí están las reglas y un ejemplo de cada una.

> **Lo que ya se hace cumplir y lo que todavía no.** Hoy solo existe `GET /health`, así que casi todo lo de abajo
> se cumple por construcción. Lo que sí vigilan pruebas, desde ahora, sobre el contrato `openapi.json`: las
> rutas, que toda operación declare su error, los nombres, los enteros del dinero y de las cantidades, los
> instantes, los días y los identificadores (`src/adapters/in/http/api-conventions.ts`). Los **ejemplos de
> endpoints de negocio son ilustrativos**: todavía no existen.

## Versión y rutas

- Las rutas de negocio empiezan por **`/v1/`**, en minúsculas, con guiones y en plural: `/v1/sale-lines`,
  `/v1/products/{productId}`.
- **`/health` no lleva versión:** lo mira el contenedor (`HEALTHCHECK`) y el cliente para saber si hay conexión
  (ADR 0009); no puede cambiar de dirección.
- Un cambio **compatible** (un campo opcional nuevo en una respuesta, un endpoint nuevo) no cambia la versión. Uno
  **incompatible** crea `/v2/` y deja `/v1/` funcionando mientras algún dispositivo pueda tener operaciones
  pendientes con el formato viejo.

## Formato

- JSON en UTF-8, con nombres en **camelCase** y valores de enumeración en inglés y minúsculas (`"unit"`,
  `"kilogram"`).
- Los identificadores son **UUID** en texto (`"id"`, `"productId"`, `"operationId"`).
- La autenticación irá en la cabecera `Authorization: Bearer …`, sin cookies (ADR 0012).

## Dinero, cantidades y tarifas: siempre enteros

Nunca un `number` con decimales ni un texto (ADR 0014 y 0015):

| Qué                | Cómo viaja                            | Ejemplo                 |
| ------------------ | ------------------------------------- | ----------------------- |
| Dinero             | `integer`, pesos colombianos          | `"unitPrice": 4500`     |
| Cantidad           | `integer`, milésimas de la unidad     | `"quantityMilli": 1500` |
| Tarifa de impuesto | `integer`, puntos básicos (1 % = 100) | `"rateBp": 1900`        |

Un campo cuyo nombre contenga `price`, `total`, `subtotal`, `amount`, `tax`, `discount`, `cash` o `cost` **debe**
ser `integer`; uno que termine en `Milli` o `Bp`, también. La prueba del contrato lo exige.

## Instantes, días e identificadores

- Un instante (`timestamp` o un nombre que termine en `At`: `occurredAt`, `receivedAt`) es un texto **ISO 8601 en
  UTC con `Z`** y `format: date-time`: `"2026-10-20T15:00:00.000Z"`.
- Un día del negocio (un nombre que termine en `Date`: `businessDate`) es un texto `AAAA-MM-DD` con
  `format: date`, en la hora de Colombia (ADR 0016).
- Un nombre que sea `id` o termine en `Id` es `string` con `format: uuid`. **Excepción:** `traceId`, que puede
  venir del cliente.

## Errores: `application/problem+json`

**Todo** error de la API, sea cual sea su causa, tiene este cuerpo (RFC 9457) y el tipo de contenido
`application/problem+json`:

```json
{
  "type": "urn:vsd-stock:problem:shift-closed",
  "title": "Conflicto",
  "status": 409,
  "detail": "El turno ya estaba cerrado",
  "instance": "/v1/sales",
  "code": "shift-closed",
  "traceId": "3f0c9d58-8f6e-4f0a-9f0e-0d1d2a6b7c11"
}
```

Y, cuando el error es de validación, la lista de los campos inválidos:

```json
{
  "type": "urn:vsd-stock:problem:validation-failed",
  "title": "La petición no es válida",
  "status": 400,
  "detail": "Hay campos inválidos",
  "instance": "/v1/sales",
  "code": "validation-failed",
  "traceId": "3f0c9d58-8f6e-4f0a-9f0e-0d1d2a6b7c11",
  "errors": [
    { "pointer": "/lines/0/quantityMilli", "code": "out-of-range", "detail": "Debe ser positivo" }
  ]
}
```

- **El cliente decide por `code` y por el estado HTTP,** nunca por `title` ni `detail`, que pueden cambiar de
  texto. El `type` siempre es `urn:vsd-stock:problem:` más el `code`.
- Cada operación declara en el contrato una respuesta `default` con este cuerpo (`@ApiProblemResponse()`).
- **Un error inesperado no revela su causa:** el `detail` solo pide el `traceId`, y la causa queda en el registro
  del servidor. Nada de lo que lleva una cadena de consulta sale en `instance` ni en `detail`.
- Un caso propio lanza `new ApiProblem(409, 'shift-closed', 'El turno ya estaba cerrado')`, con `errors` y
  `retryAfterSeconds` opcionales.

### Los códigos por estado

| Estado | `code`               | Estado              | `code`                          |
| ------ | -------------------- | ------------------- | ------------------------------- |
| 400    | `validation-failed`  | 413                 | `payload-too-large`             |
| 401    | `unauthenticated`    | 415                 | `unsupported-media-type`        |
| 403    | `forbidden`          | 425                 | `too-early`                     |
| 404    | `not-found`          | 429                 | `rate-limited`                  |
| 405    | `method-not-allowed` | 500                 | `internal-error`                |
| 408    | `request-timeout`    | 502 · 503 · 504     | `service-unavailable`           |
| 409    | `conflict`           | otro 4xx · otro 5xx | `client-error` · `server-error` |

Un caso propio usa su propio `code` (`shift-closed`, `operation-id-reused`) con el estado que le corresponda.

El 410 (`gone`) es para lo que existió y ya no sirve, como una invitación vencida. Los códigos propios del negocio y las
personas ([ADR 0023](adr/0023-negocio-personas-e-invitaciones.md)) son: `already-member` (409), `no-membership` (403),
`person-not-found` (404), `last-owner` (409), `invitation-not-found` (404), `invitation-expired` (410) e
`invitation-not-pending` (409). Un 400 `validation-failed` trae en `errors` **todos** los campos que no sirven.

Los del catálogo ([ADR 0015](adr/0015-catalogo-unidades-cantidades-y-codigos.md)): `category-not-found` y
`product-not-found` (404), `category-name-taken`, `category-in-use`, `sku-taken`, `barcode-taken` y `unit-locked` (409).
Una categoría que no existe al crear o cambiar un producto no es un 404 de la ruta sino un 400 del campo
(`/categoryId`, código `unknown-category`).

Los de proveedores y compras (C2-06): `supplier-not-found` y `purchase-not-found` (404), `supplier-in-use` (409) y
`operation-id-reused` (409, ver [Idempotencia](#idempotencia)). Lo que solo la base puede saber de una compra llega como
400 del campo, con el puntero de la línea: `/supplierId` `unknown-supplier`, `/lines/1/productId` `unknown-product` o
`archived-product`, y `/lines/0/quantityMilli` `not-whole` (un producto que se cuenta en unidades enteras no admite
decimales). Un producto repetido en dos líneas es `duplicate-product` en la segunda: se juntan las cantidades.

Los ajustes de existencia (C2-07) usan los mismos problemas de campo: `/productId` `unknown-product` si el producto no
existe en el negocio (un producto archivado sí se ajusta), `/deltaMilli` `zero-delta` (un ajuste que no cambia nada) y
`/deltaMilli` `not-whole` en un producto que se cuenta en unidades enteras. El historial de un producto que no existe
responde 404 `product-not-found`: no es una lista vacía. El cursor del historial lleva el instante al milisegundo y el `id`
del último movimiento.

Los de dispositivos (C3-01, [ADR 0016](adr/0016-folios-por-dispositivo-y-hora-corregida.md)): `device-not-found` (404) y
`device-id-reused` (409). Registrar un dispositivo es idempotente por **su `id`** y no por un `operationId`: el dispositivo
se inventa el UUID antes de hablar con el servidor y lo manda en el cuerpo. Repetir el registro responde `200` con el mismo
dispositivo y `Idempotent-Replayed: true` sin gastar otro código (si ya lo dieron de baja, `revokedAt` se lo dice); el mismo
`id` con otro nombre, o el `id` de un dispositivo de otro negocio, es `409 device-id-reused`.

Los de turnos y efectivo (C3-02, [ADR 0026](adr/0026-turnos-de-caja-y-arqueo.md)): `shift-not-found` (404) y
`shift-already-open`, `shift-id-reused` y `shift-closed` (409). Abrir y cerrar un turno son operaciones con `operationId`
**y con la hora del dispositivo**: `deviceTime` (ISO 8601 UTC con `Z`) y, si se midió, `clockOffsetMs` (milisegundos que el
servidor adelanta al reloj del dispositivo). El servidor corrige la hora, guarda la cruda y las marcas, y **nunca rechaza
por la hora**: una que no se puede leer se acepta con la de llegada y la marca `unreadable`. `clockOffsetMs` no forma parte de
la huella de idempotencia. Lo que solo la base puede saber llega como 400 del campo: `/deviceId` `unknown-device` al abrir y
`/shiftId` `unknown-shift` al mover efectivo. Repetir un cierre responde `200` con `Idempotent-Replayed: true` (el cierre no
crea nada, así que no hay un `201`).

La venta (C3-03, [ADR 0027](adr/0027-registro-de-ventas-y-atencion.md)) no tiene problemas propios: casi todo lo que el
servidor encuentra raro **se acepta y se marca** en la respuesta (`needsAdjustment`, `folioConflict`, `flags`, `timeFlags`).
Lo que rechaza llega como `400 validation-failed` con el campo: `/shiftId` `unknown-shift` (no existe o no es el turno de quien
vende), `/lines/N/productId` `unknown-product` y `/lines/N/quantityMilli` `not-whole`. Como todo lo idempotente, repetirla
responde `200` con `Idempotent-Replayed: true` y la venta tal como quedó; con otro cuerpo, `409 operation-id-reused`. El dinero
va en pesos enteros y las cantidades en milésimas.

Consultar y revisar ventas (C3-04, [ADR 0027](adr/0027-registro-de-ventas-y-atencion.md)): `sale-not-found` (404). Una venta
de un turno ajeno **no existe para un cajero**: recibe el mismo 404 que por una que nunca existió, igual que un identificador
que no es un UUID. La lista va de la más reciente a la más vieja por la hora **en que ocurrieron** (no la de llegada) y su
cursor lleva el instante al milisegundo y el `id`; sus filtros son `shiftId`, `folio` (el que el dispositivo imprimió) y
`attention` (`true` o `false`, la bandeja «Requiere atención»), y pedir `attention` siendo cajero es `403 forbidden`. Revisar
una venta (`POST /v1/sales/{id}/review`) es la excepción a llevar un `operationId`: **la venta misma es la clave**, porque se
revisa una sola vez. La primera responde `201`; revisarla otra vez, quien sea, responde `200` con la revisión que ya tenía y
`Idempotent-Replayed: true`. La nota es de una línea y de 200 caracteres como mucho; si no, `400` en `/note`.

Anular una venta (C3-05, [ADR 0027](adr/0027-registro-de-ventas-y-atencion.md)): `sale-voided` y `shift-required` (409). Anular
es una operación con `operationId`, así que la primera vez responde `201` con la venta (ahora con su `voided`), repetirla `200`
con `Idempotent-Replayed: true` y el mismo `operationId` con otro cuerpo `409 operation-id-reused`. `shift-required` dice que
la venta tuvo efectivo y el turno que se nombró no existe, no es de quien anula o ya está cerrado: se nombra uno **abierto y
propio**. Si nadie pagó en efectivo, `shiftId` se puede omitir. Una venta que no existe, o que no es de este negocio, es `404
sale-not-found` como siempre.

### Qué hace el cliente con cada estado

Es la tabla de las clases de fallo del [ADR 0009](adr/0009-motor-offline-y-libro-de-movimientos.md):

| Lo que pasó                                     | Clase      | Qué se hace                                        |
| ----------------------------------------------- | ---------- | -------------------------------------------------- |
| No hubo respuesta, o no era JSON                | Red        | Se detiene todo; no gasta un intento               |
| 401                                             | Sesión     | Se detiene todo; **la cola se conserva**           |
| 408, 425, 429 y 5xx                             | Pasajero   | Espera creciente con azar; respeta `Retry-After`   |
| 409                                             | Conflicto  | Se marca; no se pisa nada; se muestra a la persona |
| Cualquier otro 4xx (400, 403, 404, 405, 413...) | Permanente | Se marca para atención; no bloquea a las demás     |

## Idempotencia

Cada operación que cambia algo lleva en **el cuerpo** su `operationId` (UUID, creado una sola vez en el
dispositivo, ADR 0009):

```json
{ "operationId": "9d7f6a3e-2b1c-4e55-9a77-6a1f0c3d2b10", "shiftId": "…", "lines": [ … ] }
```

- La primera vez responde **`201 Created`** con el recurso.
- **Reenviar la misma operación** responde **`200 OK`** con **el mismo cuerpo** y la cabecera
  **`Idempotent-Replayed: true`**; no crea nada dos veces.
- **El mismo `operationId` con un cuerpo distinto** es un defecto del cliente: responde **`409`** con el código
  `operation-id-reused`, para que el cliente no crea que se aplicó lo nuevo.
- **Qué es «el mismo cuerpo»:** la huella se calcula sobre lo que el servidor ya leyó y validó, sin el `operationId`: el
  orden de las claves, las mayúsculas de los identificadores y los espacios sobrantes no la cambian. En la base se guarda
  solo esa huella (SHA-256) con la clase de operación y quién la hizo, nunca el cuerpo.
- **Si la operación se rechaza** (400, 403, 409...) no queda nada: el `operationId` sigue libre y se puede reintentar con
  los datos corregidos. Reclamarlo y aplicarlo ocurren en la misma transacción.
- **Dos iguales a la vez:** la segunda espera a la primera y responde `200` con lo que ella hizo. Si dos transacciones
  chocan entre sí (interbloqueo o fallo de serialización), el servidor repite la transacción entera hasta tres veces antes
  de responder error.
- Un envío en lote (`POST /v1/sync`, que se define con el motor del Ciclo 3) responde `200` con un resultado por
  operación, cada uno con su propio estado y, si falló, su `ProblemDetails`.

## Paginación

Por **cursor**, no por página: así una lista que cambia mientras se lee no repite ni se salta filas.

```
GET /v1/products?limit=50&cursor=eyJ…
→ { "items": [ … ], "nextCursor": "eyJ…" }       (nextCursor es null en la última)
```

- `limit` va de 1 a 200 y por omisión es 50. El cursor es **opaco**: el cliente no lo lee ni lo arma.
- El orden es estable (por instante y por `id`). **No hay total:** contarlo es caro y inconsistente.
- Un cursor que el servidor no hizo, o cuyo `id` no es un UUID, responde 400 `validation-failed` con `/cursor` `invalid-cursor`.
  Las compras van de la más nueva a la más vieja y su cursor lleva el instante al milisegundo y el `id`.

## Cabeceras

| Cabecera                  | Cuándo                                | Para qué                                                                                                                                                                 |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `X-Request-Id`            | En cada petición y en cada respuesta  | El cliente puede mandar su propio identificador (de 8 a 64 caracteres seguros); si no, el servidor pone un UUID. Es el `traceId` de los errores y aparece en el registro |
| `Retry-After`             | En un 429 y en un 503 que lo sepan    | Segundos que conviene esperar antes de reintentar                                                                                                                        |
| `Idempotent-Replayed`     | Al reenviar una operación ya aplicada | Dice que la respuesta es la de la primera vez                                                                                                                            |
| `Cache-Control: no-store` | En toda respuesta                     | Nada se guarda en una cache: una respuesta vieja es una respuesta equivocada                                                                                             |

Las tres primeras están en `Access-Control-Expose-Headers`: sin eso, el navegador las esconde al frontend, que
vive en otro origen (ADR 0012).
