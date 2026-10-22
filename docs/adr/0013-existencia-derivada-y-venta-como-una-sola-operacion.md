# ADR 0013 — La existencia es un saldo derivado y la venta es una sola operación

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 1

## Contexto

El [ADR 0009](0009-motor-offline-y-libro-de-movimientos.md) decidió que el inventario es un libro de
movimientos inmutables y que la existencia es su suma, y dejó abiertas dos preguntas del
[mapa de contextos](../dominio/mapa-de-contextos.md):

- **¿Cómo se mantiene el saldo de existencias sin perder la idempotencia?** Sumar los movimientos en cada
  lectura puede ser lento, y un saldo mal mantenido es peor que ninguno.
- **¿Una venta y sus movimientos de stock y de caja son realmente una sola transacción, y qué pasa si falla la
  mitad?** Una venta que descuenta mercancía pero no cobra, o que cobra pero no descuenta, deja la caja o el
  inventario descuadrados sin que nadie lo vea.

En vez de decidirlo sobre el papel, lo probamos contra un **PostgreSQL 17 real**:
[`test/integration/ledger.integration.spec.ts`](../../test/integration/ledger.integration.spec.ts) y su esquema
[`ledger-design.ts`](../../test/integration/support/ledger-design.ts) son la especificación ejecutable de esta
decisión; las migraciones reales del Ciclo 2 la traducen a Prisma.

## Decisión

1. **El libro solo se agrega.** `stock_movement` no admite `UPDATE`, `DELETE` ni `TRUNCATE`: lo impiden los
   permisos del rol de la aplicación **y** un disparador que rechaza el cambio incluso a quien es propietario de
   la tabla. Corregir es agregar un movimiento que compensa.
2. **La existencia es una fila por producto (`stock_balance`) que mantiene un disparador**, en la misma
   transacción que el movimiento: `AFTER INSERT` con un `INSERT … ON CONFLICT DO UPDATE` que **suma** el cambio.
   La aplicación **solo puede leer** el saldo; no existe ningún camino de código que lo escriba. La suma de los
   movimientos sigue siendo la verdad: una consulta de conciliación (en las pruebas, `driftedBalances`) la
   compara con el saldo y debe devolver cero filas.
3. **El disparador es `SECURITY DEFINER` con `search_path` vacío**, y su propietario es un rol **sin
   superusuario y sin `BYPASSRLS`**. Funciona igual porque el contexto del negocio
   (`app.id_negocio`, [ADR 0005](0005-aislamiento-por-negocio-en-la-base-de-datos.md)) sigue puesto dentro de la
   transacción. Consecuencia buscada: **un movimiento escrito sin contexto de negocio falla**, incluso si lo
   escribe un superusuario; no hay forma silenciosa de dejar el saldo sin actualizar.
4. **La idempotencia es la clave primaria.** La tabla `operation` tiene `PRIMARY KEY (id_negocio, operation_id)`.
   Lo primero que hace cada operación, **dentro de la transacción**, es reclamarla con
   `INSERT … ON CONFLICT DO NOTHING`. Si ya existía, devuelve lo que se respondió la primera vez y no escribe
   nada. Si otra transacción la está reclamando en ese instante, el `INSERT` espera: si esa confirma, esta es una
   repetición; si esa se deshace, la reclamamos nosotros. **El mismo `operationId` en otro negocio es otra
   operación.**
5. **Una venta es una sola transacción.** En este orden: reclamar la operación → escribir los movimientos de
   stock → comprobar si algún producto quedó en negativo → bloquear el turno → escribir la venta → escribir el
   cobro en efectivo. Si algo falla **no queda nada, ni siquiera el reclamo**, así que el mismo `operationId` se
   puede reenviar. Probado con un turno cerrado y con la conexión cortada (`pg_terminate_backend`) a mitad de la
   venta.
6. **«Requiere ajuste» se decide leyendo los saldos ya actualizados**, bajo el candado que la propia venta tomó
   sobre sus filas. Una venta se acepta siempre (ADR 0009); queda marcada cuando algún producto suyo termina con
   existencia **menor que cero** (cero no marca). Con 20 ventas simultáneas de un producto con 10 unidades,
   quedan marcadas **exactamente 10**.
7. **Los candados se toman en un orden fijo.** Los movimientos de una venta se escriben ordenados por producto:
   dos ventas que comparten productos se turnan y nunca se esperan en círculo. Aun así, quien implemente la
   unidad de trabajo debe **reintentar ante `40001` y `40P01`**: es seguro porque la operación se reclama dentro
   de la transacción que se deshizo.
8. **El turno se bloquea al final y en modo compartido** (`SELECT … FOR SHARE`): cerrar el turno espera a las
   ventas en curso, así que el arqueo no se pierde ninguna, y el candado dura lo mínimo.
9. **Las claves foráneas son compuestas**, `(id_negocio, id)`: la base impide que una venta apunte al turno de
   otro negocio, aunque el código se equivoque.
10. **Nivel de aislamiento: `READ COMMITTED`** (el de PostgreSQL por omisión). No hace falta `SERIALIZABLE`: el
    candado de la fila del saldo hace el trabajo de serializar lo que importa.

### Lo que se midió

`npm run bench:stock` ([`stock-ledger.benchmark.spec.ts`](../../test/benchmark/stock-ledger.benchmark.spec.ts)):
medianas de dos corridas, PostgreSQL 17 en Docker sobre un equipo de desarrollo con Windows 11, con RLS y
conexión local. **Sirve el orden de magnitud y la proporción, no el valor absoluto**; los tiempos de una
consulta de un solo producto están dominados por el viaje de ida y vuelta.

| Movimientos | Productos | Leer 1 producto: suma | Leer 1 producto: saldo | Leer todos: suma | Leer todos: saldo | Escribir con saldo | Escribir sin saldo |
| ----------- | --------- | --------------------- | ---------------------- | ---------------- | ----------------- | ------------------ | ------------------ |
| 10 mil      | 100       | 0,7–0,9 ms            | 0,55 ms                | 2,2 ms           | 0,75 ms           | 0,58 ms            | 0,55–0,63 ms       |
| 100 mil     | 200       | 0,73–0,78 ms          | 0,48–0,55 ms           | 14 ms            | 0,8 ms            | 0,56–0,58 ms       | 0,64–0,68 ms       |
| 1 millón    | 2.000     | 0,8–0,97 ms           | 0,52–0,56 ms           | 52–55 ms         | 1,8–2,3 ms        | 0,55–0,65 ms       | 0,49–0,53 ms       |

Veinte cajas vendiendo **el mismo producto sin parar** (la fila caliente del saldo) sostuvieron unas **465
ventas por segundo**, muy por encima de lo que vende una tienda de barrio.

Lo que dicen los números:

- **Leer una existencia suelta** cuesta lo mismo con suma o con saldo, hasta un millón de movimientos, porque el
  índice `(id_negocio, product_id)` deja pocas filas por producto.
- **Leer todas las existencias** (la lista de productos del punto de venta, las alertas, los reportes) crece
  con el libro: unas 25 veces más lento con suma a un millón de movimientos, y seguiría creciendo cada año.
- **Mantener el saldo no se nota** al escribir (la diferencia cae dentro del ruido).

La velocidad **no es** la razón decisiva. Lo es la corrección: la prueba _«would miss an oversell if the check
read a plain sum»_ demuestra que, con solo la suma, **dos ventas simultáneas del último artículo creen que
quedaron en cero cuando la existencia real quedó en −1, y ninguna se marca**. El candado de la fila del saldo es
lo que obliga a la segunda a esperar y ver la verdad.

## Alternativas consideradas

### Solo la suma de los movimientos, en cada lectura

Es lo más simple y para una existencia suelta alcanza. Pero los listados crecen sin límite con el libro, y,
sobre todo, **no puede marcar bien «requiere ajuste»** bajo concurrencia (la prueba arriba). Habría que añadir un
candado aparte, que es el saldo con otro nombre.

### Un saldo que mantiene la aplicación

Con el mismo `INSERT … ON CONFLICT` funciona, pero cada camino de código que escriba un movimiento (una compra,
un ajuste, una importación, un módulo futuro) tiene que acordarse de actualizar el saldo, y la aplicación
necesitaría permiso de escritura sobre él. Con el disparador el invariante **«saldo = suma»** no depende de la
disciplina de nadie.

### Una vista materializada

Se refresca fuera de la transacción: la lectura queda desfasada justo cuando una venta necesita saber si el
inventario alcanza.

### Aislamiento `SERIALIZABLE`

Evita el mismo problema, pero a cambio de abortar transacciones por contención y obligar a reintentar casi
siempre. El candado de fila es más barato y más fácil de razonar.

### Guardar el saldo en el dispositivo

Es lo que el ADR 0009 descartó: con dos cajas sin conexión gana la última que escribe y se pierden ventas.

## Consecuencias

### A favor

- El saldo **no puede desviarse** del libro por un olvido de código, y el libro **no puede editarse**.
- Una venta es **todo o nada**, y reenviarla es siempre seguro, también cuando se envía diez veces a la vez.
- La existencia se lee en tiempo constante aunque el libro crezca.
- Un negocio no puede ver ni referenciar los datos de otro, ni siquiera por un error del disparador.

### En contra

- **Hay lógica en la base de datos.** Los disparadores y los permisos viven como SQL dentro de las migraciones,
  fuera del dominio hexagonal ([ADR 0003](0003-el-dominio-se-escribe-sin-framework.md)), y Prisma no los modela:
  se escriben a mano en la migración. Por eso solo se pueden probar contra PostgreSQL real, y por eso esta
  decisión trae sus pruebas.
- **La fila del saldo es un punto caliente**: todas las ventas del mismo producto se turnan. Medimos unas 465
  por segundo con 20 cajas; una tienda no se acerca. Si un día importara, el saldo se podría particionar.
- **Mientras una venta no confirma, retiene los candados** de sus productos. Las transacciones deben ser cortas:
  nada de llamadas de red adentro.
- Un movimiento sin contexto de negocio **falla a propósito**. Los scripts de mantenimiento y las cargas masivas
  deben fijar el negocio por transacción como lo hace la API.
- Quien tenga privilegios de propietario y desactive el disparador puede desviar el saldo. Mitigación: la
  consulta de conciliación se corre periódicamente (queda para el Ciclo 4) y la desviación se corrige con un
  movimiento, no editando el saldo.
- El diseño probado es un esquema de juguete; **no está probado con Prisma** ni con el pooler de Supabase en modo
  transacción (el contexto local a la transacción debería funcionar, [ADR 0005](0005-aislamiento-por-negocio-en-la-base-de-datos.md),
  pero hasta el Ciclo 2 es una hipótesis).

### Mitigación acordada

- El Ciclo 2 empieza escribiendo la migración real **a partir de las pruebas de este ADR**: las mismas
  comprobaciones se apuntan a las tablas reales, como ya se hizo con las del aislamiento.
- Las mediciones son reproducibles (`npm run bench:stock`) y se repiten con datos reales antes de la entrega.
- Este ADR usa enteros sin más para la cantidad y el dinero, a propósito, para no mezclar decisiones: cómo se
  representan y se redondean lo deciden los ADR siguientes del Ciclo 1.
