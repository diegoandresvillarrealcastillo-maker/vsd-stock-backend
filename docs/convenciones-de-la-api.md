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

## Cabeceras

| Cabecera                  | Cuándo                                | Para qué                                                                                                                                                                 |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `X-Request-Id`            | En cada petición y en cada respuesta  | El cliente puede mandar su propio identificador (de 8 a 64 caracteres seguros); si no, el servidor pone un UUID. Es el `traceId` de los errores y aparece en el registro |
| `Retry-After`             | En un 429 y en un 503 que lo sepan    | Segundos que conviene esperar antes de reintentar                                                                                                                        |
| `Idempotent-Replayed`     | Al reenviar una operación ya aplicada | Dice que la respuesta es la de la primera vez                                                                                                                            |
| `Cache-Control: no-store` | En toda respuesta                     | Nada se guarda en una cache: una respuesta vieja es una respuesta equivocada                                                                                             |

Las tres primeras están en `Access-Control-Expose-Headers`: sin eso, el navegador las esconde al frontend, que
vive en otro origen (ADR 0012).
