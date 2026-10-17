# ADR 0021 — El esquema real: Prisma, una migración revisada a mano y una base que se prueba tal como es

- **Estado:** Aceptada
- **Fecha:** 2026-10-17
- **Ciclo:** 2

## Contexto

El [ADR 0020](0020-se-congela-el-modelo-del-dominio.md) congeló veinte tablas, pero hasta aquí solo existían como
documento y como esquemas de juguete dentro de las pruebas del Ciclo 1 (existencias, catálogo, folios, aislamiento).
Esas pruebas demostraron las reglas; no demostraron que las reglas sobrevivan a Prisma, a los permisos de un rol real
ni al pooler de Supabase. Los ADR [0013](0013-existencia-derivada-y-venta-como-una-sola-operacion.md) y
[0015](0015-catalogo-unidades-cantidades-y-codigos.md) y el [0020](0020-se-congela-el-modelo-del-dominio.md) dejaron
dicho que el Ciclo 2 **abre con la migración real escrita a partir de esas pruebas**, y el 0020 advirtió el peligro de
tener el modelo descrito en dos sitios (el documento y el esquema) sin nada que los vigile.

Hay además tres cosas que ningún ADR anterior decidió: cómo se escribe la migración si Prisma no sabe expresar la
seguridad por fila, los disparadores ni las restricciones; cómo sabe la API a qué negocio pertenece una persona antes
de poder fijar el negocio (la seguridad por fila exige el contexto del negocio para leer cualquier fila); y qué pasa
con los permisos que Supabase entrega por omisión.

## Decisión

1. **Prisma 7.10.1, exacta, con el adaptador de PostgreSQL** (`@prisma/client` y `@prisma/adapter-pg`; el CLI es
   dependencia de desarrollo). Lo fijó el [ADR 0006](0006-stack-y-versiones.md). El cliente se genera en
   `src/generated/` (no se versiona) con `npm ci` o `npm run prisma:generate`, y la imagen de Docker lo genera al
   construirse.
2. **La estructura la genera Prisma y lo demás se escribe a mano en el mismo SQL.** `prisma/schema.prisma` describe
   tablas, columnas, claves e índices; `prisma migrate diff --from-empty --to-schema` produce la parte estructural y
   el archivo de la migración añade lo que Prisma no expresa: **columnas generadas** (las claves de comparación del SKU,
   del código de barras y del nombre de categoría, que calcula la base y no la aplicación), **restricciones CHECK**
   (las del dominio: unidades, tarifas, roles, alfabeto de los códigos de dispositivo, precio y cantidad máximos),
   **seguridad por fila**, **disparadores** y **permisos**. Hay **una sola migración**,
   `20261017120000_modelo_inicial`.
3. **Las veinte tablas van en esta primera migración,** aunque Ventas y Caja las use el Ciclo 3. El modelo está
   congelado y las especificaciones del Ciclo 1 ya cubren esas tablas; así el esquema completo se verifica **una
   vez** contra Supabase en lugar de a pedazos. Las **columnas** que las pruebas no fijan todavía (por ejemplo los
   desgloses de IVA de la venta) no se inventan ahora: llegan con la migración del ciclo que las usa.
4. **Las tablas viven en `public`, con la Data API de Supabase apagada** y sus permisos por omisión retirados. Nuestra
   API se conecta directo a PostgreSQL con el rol `stock_app`; nadie más necesita ver las tablas. La migración quita
   cualquier permiso a `anon`, `authenticated` y `service_role` si esos roles existen, por si la Data API se encendiera
   por error.
5. **El rol de la aplicación lo crea una persona antes de migrar** (`stock_app`, sin privilegios, sin `BYPASSRLS`, no
   dueño de nada): lleva contraseña y esa no se versiona. La migración se niega a correr si falta, con un mensaje que
   remite a `docs/ambientes.md`, y concede lo mínimo: leer y escribir donde hay que hacerlo, **nunca editar ni borrar
   donde hay historia**, y solo leer el saldo de existencias (lo escribe el disparador).
6. **El dueño de las tablas es el rol que migra.** En las pruebas es `stock_owner_test`, un rol que **no** es
   superusuario ni salta la seguridad por fila: si todo funciona con un dueño sujeto a RLS, funciona también con el
   `postgres` de Supabase, que es más permisivo.
7. **La identidad se resuelve con una segunda política de solo lectura.** Antes de saber el negocio, la API conoce
   quién es la persona (el `sub` del token verificado). La política `identity_lookup` de `app_user`, solo `SELECT`,
   deja ver **la fila propia y ninguna otra** cuando la transacción trae `app.auth_user_id`; con ella la API averigua
   negocio y rol y recién entonces abre la transacción con `app.id_negocio`. Sin ninguno de los dos contextos, no se
   ve nada.
8. **Donde hay historia, la base misma se niega a editar.** Un disparador común (`refuse_history_change`) impide
   `UPDATE`, `DELETE` y `TRUNCATE` en los movimientos de stock, las operaciones, las compras y sus líneas, los
   movimientos de caja, las ventas, sus líneas, sus pagos y sus anulaciones, **incluso a quien es dueño de la
   tabla**. Y otro impide cambiar la **unidad** de un producto que ya tiene movimientos: la deuda que dejó el
   [ADR 0015](0015-catalogo-unidades-cantidades-y-codigos.md).
9. **Una invitación pendiente es una fila de `app_user`, no una tabla nueva:** mientras no se canjea, `auth_user_id`
   está vacío y la fila guarda el hash del código y su vencimiento. Una restricción exige que cada fila o esté ligada
   a una identidad o sea una invitación completa.
10. **Se corrige el diagrama** en seis relaciones que la migración exige y el diagrama no dibujaba: `operation` con la
    persona que la hizo y, si vino de uno, el dispositivo; `device` con quien lo registró; `purchase` con quien la creó
    y con su `operation`; y `sale_void` con su `operation`. No se agrega ninguna tabla.
11. **Cómo se aplica.** Una persona, con `npm run db:migrate`: muestra a qué host apunta la conexión (sin la
    contraseña) y, si no es la máquina local, pide escribir el host para confirmar. El CI y las pruebas aplican las
    mismas migraciones con Prisma a **su propia base desechable**, y se niegan a borrar nada que no sea local y cuyo
    nombre no termine en `_test`.
12. **Dos descripciones, dos pruebas.** El documento del modelo y las migraciones tienen que dar las mismas tablas y las
    mismas relaciones (`test/docs/modelo.spec.ts`); y `schema.prisma` y la base migrada no pueden separarse
    (`test/integration/schema-drift.integration.spec.ts`, que ejecuta `prisma migrate diff`).
13. **Para la API, el pooler de sesión (puerto 5432) por omisión.** Es un servidor de vida larga con su propio grupo de
    conexiones, como el anterior VSD Stock. Que además funcione en modo transacción (6543) es lo que verifica el ticket
    C2-13 contra una base real.

## Alternativas consideradas

### SQL a mano sin Prisma (un constructor de consultas o un ejecutor de migraciones propio)

Quitaría la magia, pero pierde los tipos generados y obliga a reescribir lo que el [ADR 0006](0006-stack-y-versiones.md)
ya fijó y el equipo conoce. Se queda Prisma para la estructura y el cliente, y SQL para lo que Prisma no sabe.

### Dejar que Prisma genere todo y editar la migración con `migrate dev`

Es lo habitual, pero `migrate dev` necesita una base «sombra» y reescribe la migración si el esquema cambia mientras
se edita. `migrate diff` produce el SQL una vez, sin tocar ninguna base, y lo que se añade a mano queda donde se ve.

### Un esquema de PostgreSQL propio (`stock`) en lugar de `public`

Aislaría las tablas de la Data API sin depender de que esté apagada. Prisma lo soporta, pero cada consulta, función y
permiso lleva el esquema, y las migraciones, el pooler y los reportes se complican. Apagar la Data API **y** retirar los
permisos por omisión da la misma garantía con menos piezas.

### Solo las tablas que usa el Ciclo 2

Migración más pequeña, pero tres migraciones en vez de una, cada una por verificar contra Supabase, y el esquema de
Ventas y Caja habría que reescribirlo desde las pruebas del Ciclo 1 otra vez.

### Una tabla de identidades sin seguridad por fila para saber el negocio de cada persona

Resolvería el problema de la identidad, pero sería la tabla veintiuna, rompería el congelamiento del modelo y tendría
que quedar fuera de la protección que el [ADR 0005](0005-aislamiento-por-negocio-en-la-base-de-datos.md) exige a todo.

### Una función `SECURITY DEFINER` que resuelva la identidad

Evita tocar la política, pero la función corre como el dueño, y un dueño sujeto a RLS (como el de las pruebas) tampoco
ve la fila sin contexto. Dependería de que el dueño real se salte la seguridad por fila, que es justo lo que no queremos
suponer.

### Dejar las reglas (unidad inmutable, historia inmutable) solo en la aplicación

La aplicación puede olvidarse; un script de mantenimiento no pasa por ella. Son tres disparadores pequeños y son
la última barrera.

## Consecuencias

### A favor

- Las especificaciones del Ciclo 1 se volvieron las primeras pruebas del esquema real: lo que demostraron ahora vale
  para lo que existe.
- La base misma hace cumplir lo importante (aislamiento, historia inmutable, unidad, códigos únicos, formas y rangos),
  de modo que ninguna ruta de código —ni un script— puede saltárselo sin que alguien lo note.
- Modelo, migración y esquema de Prisma no pueden separarse sin que una prueba falle y diga cuál es la diferencia.
- Nadie aplica una migración sin ver antes a qué base va.

### En contra

- **Dependemos de Prisma 7 recién salido** y de su adaptador; el cliente generado son unos 2 MB de TypeScript que hay
  que producir en cada instalación y en cada imagen de Docker.
- **Lo que está escrito a mano no lo ve Prisma:** `migrate diff` no detecta que alguien cambie una restricción,
  una política o un disparador. Eso lo vigilan las pruebas de integración, que son tan buenas como los casos que
  recorren.
- **Los nombres de restricciones que genera Prisma son largos** (`sale_id_negocio_shift_id_fkey`) y cambian si se
  renombra una columna.
- **Las pruebas usan `session_replication_role = replica` para vaciar la base** (el libro no se puede truncar con sus
  disparadores). Es un permiso de superusuario que solo existe en la base de pruebas.
- **`identity_lookup` amplía lo que la aplicación ve sin contexto de negocio:** su propia fila. Descansa en que la API
  fije `app.auth_user_id` solo con un token verificado, la misma confianza que ya se deposita en `app.id_negocio`.
- **El adaptador de Prisma con el pooler de Supabase en modo transacción no está verificado.** La documentación de
  Supabase pide desactivar las sentencias preparadas en ese modo y no está claro cómo lo expresa el adaptador. Hasta
  C2-13 la API se apoya en el pooler de sesión.
- **Veinte tablas y una sola migración:** si algo en ella estuviera mal, la corrección es otra migración sobre datos
  que ya existen.
- **La Data API apagada es una instrucción para una persona,** no algo que el repositorio pueda hacer cumplir; lo que sí
  hace la migración es retirar los permisos por si se enciende.

### Mitigación acordada

- C2-13 corre un script contra el proyecto de PRE que comprueba, con una base y un servicio de identidad reales, lo que
  aquí es hipótesis: los disparadores y las políticas con Prisma, el contexto del negocio en el pooler de sesión y en el
  de transacción, y que `stock_app` no se salta nada.
- Las pruebas de integración recorren cada restricción con un caso válido y uno inválido, y los permisos de `stock_app`
  tabla por tabla; la matriz de permisos está escrita en la prueba y no se deduce de la migración.
- Toda migración posterior se aplica con el mismo comando y las mismas pruebas.
