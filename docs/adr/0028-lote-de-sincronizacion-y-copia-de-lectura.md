# ADR 0028 — Lote de sincronización y copia de lectura: un resultado por operación y datos con su hora

- **Estado:** Aceptada
- **Fecha:** 2026-10-20
- **Ciclo:** 3

## Contexto

El [ADR 0009](0009-motor-offline-y-libro-de-movimientos.md) decidió que el dispositivo guarda una **cola de operaciones** y la
envía cuando hay conexión, y el [ADR 0019](0019-convenciones-de-la-api.md) puso el `operationId` en el cuerpo «para que un envío
en lote lleve una por operación», pero ningún endpoint ejerció el lote. Hoy cada operación tiene su ruta (`POST /v1/shifts`,
`POST /v1/shifts/{id}/close`, `POST /v1/sales`); un teléfono que estuvo una tarde sin red tiene decenas esperando, y mandarlas
una por una multiplica los viajes justo cuando la conexión es mala.

También falta lo que el mostrador necesita **para vender sin red**: el catálogo (nombre, SKU, código, precio, tarifa, unidad) y
la existencia, copiados al dispositivo y puestos al día de manera barata. El ADR 0019 (punto 10) lo dejó dicho: ninguna respuesta
se guarda en una caché HTTP; la copia de lectura es del dispositivo, con fecha y a propósito.

## Decisión

### El lote (`POST /v1/sync`)

1. **Un lote es una lista ordenada de operaciones que ya existen**: `{ "operations": [ { "kind", "body" } ] }`. `kind` es
   `shift-open`, `shift-close` o `sale` y `body` es **exactamente el cuerpo** de la ruta individual de esa clase. Cerrar un turno
   lleva además `shiftId`, que en la ruta suelta va en el camino (`POST /v1/shifts/{id}/close`) y aquí no tiene otro lugar. Son las únicas
   tres que el ADR 0017 permite hacer sin conexión; las demás (anular, mover efectivo, compras, ajustes) son de la gerencia, con
   conexión, y se piden por su propia ruta. De un lote entran de 1 a **50** operaciones; si no, `400 validation-failed`.
2. **Cada operación va en SU PROPIA transacción**, una tras otra, en el orden en que llegaron (abrir un turno y vender en él
   caben en el mismo lote). Que una falle no deshace las demás. **Reutiliza los casos de uso de la ruta individual**: las mismas
   validaciones, las mismas reglas de ADR 0026 y 0027 y la misma idempotencia por `operationId` (ADR 0019). No hay una segunda
   forma de aplicar una venta.
3. **La respuesta es `200` siempre que se procesó el lote**, con un resultado por operación y en el mismo orden:
   `{ "serverTime", "results": [ { "operationId", "status", "replayed", "body", "problem" } ] }`.
   - `status` es **el estado HTTP que habría contestado la ruta individual**: `201` si se aplicó, `200` si ya estaba aplicada
     (`replayed: true`, en lugar de la cabecera `Idempotent-Replayed`) y el `4xx`/`5xx` que corresponda si no.
   - `body` trae lo que la ruta individual devuelve (la venta, el turno) cuando `status` es 2xx, y `problem`, el
     `application/problem+json` de siempre (`code`, `errors`...), cuando no. El uno o el otro, nunca los dos.
   - `operationId` repite el de la operación, o `null` si el cuerpo ni siquiera lo traía.
   - Un error inesperado de una operación es `500` **en su resultado** (con su `traceId`); no tumba las demás.
4. **El dispositivo clasifica cada resultado como clasifica una respuesta suelta** (ADR 0009, punto 6; ADR 0019, punto 5): por
   `status`. El estado del propio `POST /v1/sync` (401, 403, 429, 5xx) vale para el lote entero y se reintenta entero, porque
   la idempotencia hace seguro repetir lo que ya se aplicó.
5. **Los permisos y la sesión son los de quien envía**: un lote no da más derechos que sus operaciones sueltas. Una venta en el
   turno de otra persona sigue siendo `400 /shiftId unknown-shift` en su resultado.
6. **`serverTime`** (ISO 8601 UTC) es la hora del servidor al contestar: con ella y las horas de salida y llegada, el
   dispositivo mide cuánto adelanta el servidor a su reloj (`clockOffsetMs`, ADR 0016) sin una llamada más.
7. **Un lote más grande que el límite de cuerpo del servidor es `413`**; el motor manda lotes de hasta 20 operaciones o 64 KB,
   lo que llegue primero, y por eso nunca se acerca.

### La copia de lectura (`GET /v1/sync/...`)

8. **Dos lecturas, las dos para los tres roles** (un cajero necesita el catálogo para vender): `GET /v1/sync/products` y
   `GET /v1/sync/stock`. Contestan `{ "asOf", "items", "nextCursor" }` y paginan por cursor (`limit` de 1 a 200, 50 por omisión,
   ADR 0019). Las categorías son pocas y ya tienen su lista (`GET /v1/categories`): no llevan una copia aparte.
9. **Incrementales por `since`.** Sin `since` bajan todo; con `since` (un instante) solo lo que cambió **después**, comparado al
   **milisegundo** como el cursor: con la fracción más fina, un producto de la misma milésima que el último de la página volvería
   a salir en la siguiente y la descarga no terminaría nunca. Los
   productos van **ordenados por `updatedAt` y luego por `id`, de lo más viejo a lo más nuevo**, para que una descarga a medias se
   reanude con el cursor. **Incluyen los archivados** (`active: false`): así el dispositivo los quita de su copia.
10. **Las existencias salen del libro**: un producto aparece si tiene un movimiento posterior a `since`, con su saldo de ahora
    (`quantityMilli`), ordenado por `productId`. No se agregó ninguna columna al modelo congelado (ADR 0020).
11. **`asOf` es la hora del servidor al leer** esa página. El dispositivo guarda la del PRIMER lote de una descarga, le resta un
    margen de **un minuto** (una transacción que empezó antes de `asOf` puede confirmarse después con una hora anterior) y la usa
    como `since` la próxima vez. Aplicar dos veces el mismo producto no hace daño: se reemplaza por `id` y gana el `updatedAt` mayor.
12. **La existencia que muestra el dispositivo lleva su hora** («al…»): `asOf` más lo vendido aquí y todavía sin enviar. Nadie
    debe leer esa cifra como la existencia de hoy en todas las cajas.

## Alternativas consideradas

- **Un `POST /v1/sync` que reciba la cola entera en una sola transacción:** una venta rara arrastraría a las demás, y el ADR 0009
  prohíbe rechazar una venta ya hecha. Una transacción por operación es lo que ya hace cada ruta individual.
- **Responder `207 Multi-Status`:** es lo que usa WebDAV, pero obliga al cliente a leer un cuerpo para saber si el lote llegó. Con
  `200` y un `status` por operación, el estado de la petición dice si el lote se procesó y el cuerpo, qué pasó con cada una.
- **Una clase de operación por ruta de lote** (`/v1/sync/sales`, `/v1/sync/shifts`): rompe el orden entre abrir un turno y vender en
  él, que es el caso normal de la primera conexión de una tarde.
- **Mandar el lote como la cola cifrada y que el servidor la abra:** el servidor no tiene la clave y no debe tenerla (ADR 0018).
- **Que cada operación lleve una cabecera de idempotencia:** ya descartado en el ADR 0019.
- **Copia completa cada vez:** simple y sin riesgo de perder un cambio, pero para un negocio de miles de productos es mucho dato
  móvil en cada conexión. El margen de un minuto y la idempotencia de aplicar hacen seguro lo incremental.
- **Cambios por «versión de la copia» en vez de por hora:** exige una secuencia global en el servidor y una columna nueva en un modelo
  congelado. La hora de la fila y su margen bastan.
- **Una columna `updated_at` en `stock_balance`:** el libro de movimientos ya dice qué cambió y cuándo, y no se toca el modelo.

## Consecuencias

### A favor

- **Una conexión corta vacía una cola larga** en pocos viajes, y cada venta sigue siendo todo o nada.
- **Una sola forma de aplicar cada operación:** el lote y la ruta suelta comparten caso de uso, reglas y pruebas.
- **El dispositivo decide qué hacer con cada resultado con la misma tabla de siempre** (reintentar, marcar, pedir atención).
- **La copia de lectura es barata de mantener** y no toca el esquema.
- **Lo que se ve en el mostrador dice de cuándo es.**

### En contra

- **Un resultado `500` dentro de un `200` es fácil de ignorar:** el motor tiene que mirar cada `status`, y hay una prueba que lo exige.
- **El orden solo se respeta dentro de un lote y entre lotes en serie:** el motor envía un lote a la vez (Web Locks, ADR 0009).
- **La existencia por movimiento posterior** recorre el libro desde `since`; con un `since` muy viejo es lo más pesado del servidor.
  Un índice sobre la hora del movimiento lo resolvería si hiciera falta; hoy el tamaño de un negocio no lo pide.
- **El margen de un minuto repite filas** que el dispositivo ya tenía; se descartan al aplicarlas.
- **Una venta a un turno que se abre en el mismo lote depende de que la apertura salga bien.** Si la apertura se rechaza, las ventas
  de ese turno se rechazan también (`unknown-shift`), y el dispositivo las marca para atención.
