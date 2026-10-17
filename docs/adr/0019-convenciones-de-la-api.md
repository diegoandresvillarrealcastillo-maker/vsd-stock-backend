# ADR 0019 — Convenciones de la API: versión, errores, enteros, instantes e idempotencia

- **Estado:** Aceptada
- **Fecha:** 2026-10-17
- **Ciclo:** 1

## Contexto

Antes de que exista el primer endpoint de negocio hay que decidir cómo habla la API, porque el contrato OpenAPI es
**lo único** que une al backend con el frontend ([ADR 0001](0001-dos-repositorios-independientes.md)) y porque el
frontend cobra cuando no hay red: una forma de error ambigua, un decimal donde iba un entero o una hora sin zona
se convierten en una venta mal cobrada o mal fechada. Los ADR del ciclo ya fijaron las piezas:

- el dinero es un entero de pesos y la cantidad un entero de milésimas ([ADR 0014](0014-dinero-impuestos-y-redondeo.md)
  y [ADR 0015](0015-catalogo-unidades-cantidades-y-codigos.md));
- la hora es un instante en UTC y el día del negocio es el de Colombia ([ADR 0016](0016-folios-por-dispositivo-y-hora-corregida.md));
- cada operación lleva un `operationId` y los fallos se clasifican por clase
  ([ADR 0009](0009-motor-offline-y-libro-de-movimientos.md));
- el token irá en una cabecera, sin cookies, y los orígenes permitidos son una lista explícita
  ([ADR 0012](0012-cors-con-lista-explicita-de-origenes-y-sin-credenciales.md)).

Este ADR junta esas decisiones con las que faltan (versión, forma de los errores, paginación, idempotencia en HTTP,
cabeceras) y las **hace comprobables**. Las reglas con ejemplos están en
[`docs/convenciones-de-la-api.md`](../convenciones-de-la-api.md).

## Decisión

1. **Versión en la ruta.** Las rutas de negocio empiezan por `/v1/`, en minúsculas, con guiones y en plural.
   **`/health` no lleva versión:** lo mira el `HEALTHCHECK` del contenedor y el cliente para saber si hay conexión
   (ADR 0009). Un cambio compatible no cambia la versión; uno incompatible crea `/v2/` y deja `/v1/` vivo mientras
   algún dispositivo pueda tener operaciones pendientes con el formato viejo, porque una operación guardada sin
   conexión se envía con el formato con que se creó.
2. **JSON en UTF-8, camelCase, identificadores UUID** y enumeraciones en inglés y minúsculas.
3. **Todo error es `application/problem+json`** (RFC 9457) con la misma forma: `type`
   (`urn:vsd-stock:problem:<code>`), `title`, `status`, `detail`, `instance`, y dos extensiones, **`code`** (estable)
   y **`traceId`**; y `errors` (campo, código y detalle, con puntero JSON) cuando la validación falla.
   **El cliente decide por `code` y por el estado HTTP,** nunca por el texto. Un filtro global
   (`ProblemDetailsFilter`) convierte **cualquier** excepción, incluidas las que Nest lanza solo, como una ruta que
   no existe.
4. **Un error inesperado no revela su causa.** Un 500 contesta solo con el `traceId`, aunque la excepción trajera un
   mensaje; la causa va al registro del servidor con ese mismo identificador. Tampoco sale una cadena de consulta,
   que puede llevar datos: ni en `instance` ni en el `detail` que arma Nest.
5. **Los estados y las clases de fallo del ADR 0009 coinciden.** Sin respuesta es _red_; 401, _sesión_; 408, 425,
   429 y 5xx, _pasajero_ (con `Retry-After` en el 429 y en el 503 que lo sepan); 409, _conflicto_; cualquier otro
   4xx, _permanente_.
6. **Enteros, no decimales:** dinero en pesos, cantidades en milésimas (`...Milli`) y tarifas en puntos básicos
   (`...Bp`). **Instantes** en ISO 8601 UTC con `Z` (`...At`, `timestamp`) y **días del negocio** como `AAAA-MM-DD`
   (`...Date`).
7. **Idempotencia en el cuerpo.** Cada operación lleva su `operationId` (UUID) en el cuerpo, no en una cabecera, para
   que un envío en lote lleve una por operación. La primera vez responde `201`; reenviarla responde `200` con el
   mismo cuerpo y la cabecera `Idempotent-Replayed: true`; **el mismo `operationId` con otro cuerpo** responde
   `409 operation-id-reused`, para que el cliente no crea que se aplicó lo nuevo. (Los puntos 7 y 8 se implementan
   con el primer endpoint de negocio: hoy no hay ninguno que cambie algo ni que liste.)
8. **Paginación por cursor opaco:** `limit` (1 a 200, 50 por omisión) y `cursor`; la respuesta es
   `{ items, nextCursor }`. El orden es estable y no hay total.
9. **`X-Request-Id`.** Cada petición lleva uno: el del cliente si trae de 8 a 64 caracteres seguros, y si no un UUID
   que pone el servidor. Se devuelve en la respuesta y es el `traceId` de los errores. Lo que no es seguro se
   reemplaza, porque acaba en los registros.
10. **Ninguna respuesta se guarda en una cache** (`Cache-Control: no-store`). Un `/health` guardado diría que hay
    conexión cuando no la hay; una existencia guardada vendería lo que ya no hay. El dispositivo tiene su propia
    copia de lectura, con fecha y a propósito.
11. **El navegador puede leer `Retry-After`, `X-Request-Id` e `Idempotent-Replayed`:** van en
    `Access-Control-Expose-Headers`. Sin eso, un frontend en otro origen no las ve, y el ADR 0009 le exige respetar
    `Retry-After`.
12. **Las convenciones se vigilan.** `findConventionViolations` recorre `openapi.json` y falla el CI si una ruta no
    tiene versión o no sigue la forma, si una operación no declara su error `problem+json`, si un campo de dinero,
    de cantidad o de tarifa no es un entero, si un instante o un día no tiene su formato, si un identificador no es
    UUID o si un nombre no es camelCase. **Hoy solo existe `GET /health`:** la primera ruta de negocio que rompa una
    regla hace fallar la prueba del contrato.

## Alternativas consideradas

### La versión en una cabecera o en el tipo de contenido

Es más «limpia», pero no se ve en un registro ni en una URL copiada, y un dispositivo con una operación guardada
necesita saber a qué versión pertenece sin abrirla. En la ruta se ve y se guarda con la operación.

### Un formato de error propio

`{ "error": "…", "message": "…" }` es lo más corriente y cada proyecto lo reinventa distinto. RFC 9457 ya define
los campos, es lo que entienden las herramientas y deja lugar para extensiones.

### Que el cliente se guíe por el texto del error

Frágil y atado al idioma. El `code` es estable y el texto puede mejorarse sin romper a nadie.

### El `operationId` en una cabecera (`Idempotency-Key`)

Es lo que hacen otras APIs para peticiones sueltas, pero en un lote no cabe una cabecera por operación, y aquí el
lote es el caso normal de la sincronización.

### Paginación por página (`page` y `pageSize`)

Una lista que cambia mientras se lee repite o se salta filas, y contar el total es caro. El cursor evita ambas.

### Dinero como texto con decimales

Es lo que usan las APIs de pagos para evitar errores de coma flotante. Aquí el peso colombiano no tiene centavos
en el comercio y un entero evita convertir en las dos puntas (ADR 0014).

### Dejar las convenciones solo escritas

Un documento no impide que un endpoint nuevo mande el total como `number` con decimales. La prueba sí.

## Consecuencias

### A favor

- Un cliente maneja **un solo formato de error** y decide por un código estable.
- Un reporte («me salió un error») se encuentra en el registro por su `traceId`.
- Los errores inesperados no filtran hosts, claves ni datos de la cadena de consulta.
- Las reglas que más dinero cuestan romper (enteros, instantes, identificadores) fallan **antes** de fusionar.
- El navegador puede, por fin, leer `Retry-After`.

### En contra

- **Las convenciones se decidieron sin un solo endpoint de negocio** que las ejercite. Es probable que alguna se
  afine con el primero (el lote de sincronización, sobre todo); cuando eso pase se reemplaza este ADR.
- **La guarda de nombres es heurística:** reconoce el dinero por palabras dentro del nombre (`price`, `total`,
  `tax`, `discount`...). Un campo de texto que las lleve, como `discountLabel`, la dispara y obliga a renombrarlo.
  Preferimos un falso aviso a un decimal silencioso.
- **Sin total en las listas:** una pantalla con «página 3 de 12» no es posible; hay «cargar más».
- **`no-store` en todo** descarta el aprovechamiento de las cachés del navegador y de un proxy. El rendimiento lo
  da la copia de lectura del dispositivo, no la cache HTTP.
- **El `409 operation-id-reused` exige guardar una huella del cuerpo de cada operación** para compararla; se
  paga con algo de espacio y una comparación por reintento.
- **El error `problem+json` es más verboso** que un código suelto. En una red lenta pesa unos cientos de bytes.
- **El cuerpo de un 404 de Nest trae su propio texto** (`Cannot GET /ruta`), en inglés. Se conserva como `detail`
  (limpio de cadena de consulta) porque el cliente no debe leerlo; si molesta, se traduce.

### Mitigación acordada

- El primer endpoint de negocio (Ciclo 2) escribe su prueba **contra estas reglas** y ajusta las que resulten
  incómodas, en un ADR nuevo si cambia alguna.
- El frontend recibe el esquema `ProblemDetails` con su contrato (PR hermano del frontend) y clasifica los fallos
  con una función de dominio que tiene sus pruebas.
- Las pruebas de mutación de este ticket demuestran que cada regla de la guarda se cumple: se rompió a propósito
  cada una y la prueba falló.
