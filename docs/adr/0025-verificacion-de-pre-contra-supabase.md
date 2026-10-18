# ADR 0025 — Verificación de PRE contra Supabase real

- **Estado:** Aceptada
- **Fecha:** 2026-10-17
- **Ciclo:** 2

## Contexto

Todo lo que el Ciclo 2 construyó se probó contra un PostgreSQL local y un emisor de identidad de mentira. Eso prueba el
código, pero deja sin comprobar cuatro cosas que dependen del servicio real: que el adaptador de Prisma funciona a través
del **pooler** de Supabase ([ADR 0021](0021-esquema-real-y-primera-migracion.md)), que la seguridad por fila y los permisos
del rol de la aplicación son los que el esquema promete ([ADR 0005](0005-aislamiento-por-negocio-en-la-base-de-datos.md)),
que la API de datos de Supabase no puede leer nuestras tablas, y que el proyecto firma con claves asimétricas que la API sabe
verificar ([ADR 0022](0022-identidad-y-sesion.md)). Un error en cualquiera de las cuatro no se ve en las pruebas: se ve el día
que alguien entra.

El proyecto de PRE lo crea una persona en su cuenta de Supabase y las claves nunca pasan por el chat ni por el repositorio.
Quien programa no opera paneles externos ni lee los `.env` de nadie (es una regla del equipo), así que la comprobación tiene que poder correrla
**esa persona**, en su máquina, y decir con claridad qué pasó.

## Decisión

1. **`npm run verify:pre` es la comprobación de PRE.** La corre una persona, compila la aplicación y prueba **el código que
   de verdad corre** (`dist/`), no una copia: el cliente de Prisma, la unidad de trabajo y las consultas. Lee las variables
   del entorno o de `.env.pre` (que no se versiona): `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `AUTH_ISSUER`,
   `AUTH_JWKS_URL` y `AUTH_AUDIENCE`, con los mismos nombres que usa la API.
2. **Nueve comprobaciones, en orden fijo:** variables presentes; dirección de la base (rol `stock_app`, el host del pooler de
   Supabase y el puerto **5432**); conexión con el rol de la aplicación, que no sea superusuario; esquema y migraciones
   aplicadas (las que este código conoce, ni más ni menos); seguridad por fila forzada en todas las tablas del negocio y
   cero filas visibles sin decir de qué negocio se pregunta; `anon`, `authenticated` y `service_role` sin privilegios sobre
   las tablas; la aplicación sin `UPDATE` ni `DELETE` sobre el historial; 25 transacciones por el adaptador (cinco a la vez)
   sin que el negocio de una se filtre a otra; y las claves de identidad publicadas, asimétricas y bajo la dirección del emisor.
3. **El pooler es el de sesión (puerto 5432), no el transaccional (6543).** El transaccional no admite sentencias preparadas y
   la aplicación fija el negocio con `set_config(..., true)` dentro de cada transacción: con el de sesión el comportamiento es
   el mismo que en local. La comprobación **rechaza** el puerto 6543 y dice por qué. Lo escrito en `docs/ambientes.md` sobre
   el modo transacción queda corregido.
4. **No imprime ningún secreto, ni dentro del mensaje de un error.** Lo que se muestra de la base es el rol, un host
   enmascarado (`*.pooler.supabase.com`), el puerto y el nombre; nunca la contraseña, la cadena de conexión, una clave ni la
   referencia del proyecto. Todo texto que viene de otra biblioteca se recorta a su primera línea y se le quita cada secreto
   conocido antes de mostrarlo. Pruebas lo vigilan con contraseñas, cadenas y claves falsas dentro de los errores.
5. **El resultado es un informe y un código de salida.** Una línea por comprobación (`[PASA]`, `[FALLA]` u `[OMITIDA]`, esta
   última cuando otra de la que depende falló) y un resumen. Sale con 0 solo si ninguna falló. Como no lleva secretos, la persona
   puede pegar **el informe completo** en el chat: es lo único que hace falta ver.
6. **Si PRE no existe todavía, el script lo dice y falla** («Faltan DATABASE_URL…»): no inventa un resultado. El PR de esta
   comprobación se puede fusionar sin PRE; lo que queda pendiente es **correrla** y anotar su resultado.
7. **No corre en el CI.** Necesitaría las credenciales de PRE como secretos del repositorio, y un repositorio público con
   credenciales de un ambiente real es un riesgo que no compensa. Las pruebas del CI cubren la lógica del informe con respuestas
   de mentira; la corrida contra PRE es una verificación manual, como la migración (ADR 0010).

## Consecuencias

### A favor

- Las cuatro cosas que ninguna prueba local puede probar se comprueban con un comando y un informe que cualquiera entiende.
- Nada secreto sale de la máquina de quien la corre, ni al chat, ni a un registro, ni a un mensaje de error.
- Probar `dist/` evita comprobar una copia que se parezca a la aplicación pero no sea ella.
- Como también corre contra la base local y el emisor de mentira, se puede ensayar sin PRE (así se ensayó).

### En contra

- **La corre una persona.** Si nadie la corre, nadie se entera de que PRE está mal; no hay un recordatorio automático.
- **Lo que dice la documentación de Supabase puede cambiar** (el nombre del pooler, los privilegios por omisión). Si cambia, la
  comprobación puede fallar por una razón que ya no es un defecto, o dejar de ver uno.
- **No prueba una sesión real:** no pide un token a Supabase ni lo verifica, no prueba el correo de confirmación ni los
  límites de uso. Eso queda para el recorrido completo del cierre del ciclo, cuando PRE exista.
- **No mide carga:** 25 transacciones demuestran que el pooler y el adaptador se entienden, no cuánto aguantan.
- Con la base de migraciones separada, **falta `DATABASE_MIGRATION_URL` y la comprobación de migraciones falla**: la aplicación no
  tiene permiso sobre la tabla de migraciones, así que no puede leerla ella misma.

## Alternativas consideradas

- **Correrla en el CI con secretos.** Descartada por el punto 7.
- **Una lista manual de consultas SQL en el panel.** Es lo que se hacía en la versión anterior; se olvida un paso y no deja un
  informe que otra persona pueda leer.
- **Que quien programa la corra con las credenciales.** Descartada: no se le dan credenciales de un ambiente real ni se operan
  paneles externos.
- **Probar con un token real de Supabase.** Más completa, pero obliga a crear una persona de prueba en PRE y a guardar su
  contraseña; se deja para el recorrido del cierre del ciclo.
