# ADR 0023 — Negocio, personas e invitaciones: cómo se abre un negocio y cómo se suma gente

- **Estado:** Aceptada
- **Fecha:** 2026-10-17
- **Ciclo:** 2

## Contexto

El [ADR 0022](0022-identidad-y-sesion.md) dejó resuelto **quién llama**: una persona que se registró en el servicio de
identidad y a la que la API busca en `app_user` por su `sub`. Quedó pendiente lo anterior y lo posterior: cómo nace un
negocio, cómo entra a él quien no lo creó (el ADR 0022 aceptó «invitaciones por código», sin correo) y quién puede
administrar a quién. Las reglas de fondo ya estaban escritas: tres roles y la tabla de permisos
([ADR 0017](0017-roles-permisos-y-modo-sin-conexion.md)), una persona pertenece a un solo negocio y una invitación
pendiente es una fila de `app_user` ([ADR 0021](0021-esquema-real-y-primera-migracion.md), punto 9), y el aislamiento
lo impone la base ([ADR 0005](0005-aislamiento-por-negocio-en-la-base-de-datos.md)).

El problema técnico central: quien canjea una invitación **todavía no pertenece a ningún negocio**, así que no puede
fijar `app.id_negocio` y la seguridad por fila no le dejaría ver la fila que va a tomar.

## Decisión

1. **Abrir un negocio** es `POST /v1/businesses` y lo hace quien se registró y aún no pertenece a ninguno. En **una
   transacción** nacen el negocio, su primera sucursal y su primera bodega (ambas «Principal») y la persona que lo abre,
   como **dueña**. Si algo falla no queda nada. Quien ya pertenece a un negocio —aunque la hayan dado de baja— recibe
   409 `already-member`: la identidad es única en `app_user` y la base lo impone aunque la API se equivoque.
2. **Una persona pertenece a un solo negocio.** Es la regla del ADR 0021 y simplifica todo lo demás (`GET /v1/me` tiene
   un solo negocio que contar). Quien quiera trabajar en dos negocios necesita dos cuentas.
3. **Invitar** es `POST /v1/invitations`: crea la fila de la persona **sin identidad** con el SHA-256 de un código y su
   vencimiento (siete días). El código se muestra **una sola vez**; el servidor guarda únicamente su hash. Es de
   **ochenta bits** al azar, escrito con el alfabeto de Crockford (treinta y dos caracteres sin I, L, O ni U),
   dieciséis caracteres agrupados de cuatro en cuatro (`0123-4567-89AB-CDEF`) para leerlo y dictarlo. Al leerlo se
   perdonan mayúsculas, guiones, espacios y las letras que se parecen a un dígito (O es 0; I y L son 1). Ochenta
   bits al azar no necesitan un hash lento ni sal: lo que se roba de la base no se puede adivinar.
4. **Qué roles se invitan:** administrador y cajero. **No se invita a un dueño:** el dueño es quien abre el negocio. Un
   segundo dueño se nombra cambiando el rol de una persona que ya está (solo lo hace un dueño), lo que además permite
   que el primero se retire sin dejar el negocio huérfano.
5. **Canjear** es `POST /v1/invitations/redeem`. La transacción fija dos valores y solo esos: `app.invitation_hash` (el
   hash del código que la persona conoce) y `app.auth_user_id` (su identidad verificada). La migración
   `20261017130000_invitaciones` suma el índice único del hash en **toda** la base (quien canjea no dice a qué negocio
   va) y dos políticas que **se suman** a las del ADR 0021:
   - `invitation_lookup` (lectura): deja ver una fila sin identidad cuyo hash es el declarado;
   - `invitation_redeem` (actualización): deja tomar esa misma fila si sigue sin canjear, está dada de alta y no venció,
     y exige que después del cambio quede ligada a **la identidad declarada y a ninguna otra**.
     Al canjear se liga la identidad, se **borran el hash y el vencimiento** (un código sirve una sola vez) y se guarda el
     correo verificado del token; desde ahí la misma transacción pasa a ser del negocio para leer su nombre.
6. **Errores del canje** (códigos estables, ADR 0019): `invitation-not-found` (404) para el código que no existe, ya se
   usó o se dio de baja —**el mismo mensaje para todo**, para no enseñar cuál fue—; `invitation-expired` (410), que sí
   se distingue porque ayuda a quien tiene un código legítimo («pide uno nuevo»); `already-member` (409), que deja la
   invitación pendiente; y `validation-failed` (400) si el texto no tiene la forma de un código.
7. **Renovar** es `POST /v1/users/{userId}/invitation`: un código nuevo y siete días más para una invitación pendiente de
   alguien dado de alta; el anterior deja de servir. Una persona que ya canjeó la suya o está dada de baja recibe 409
   `invitation-not-pending`.
8. **Quién puede qué** sale de las acciones del ADR 0017, sin tabla nueva: al **cajero** lo administra la gerencia
   (`user:manage-cashiers`); a un **administrador o a un dueño**, solo un dueño (`user:manage-admins`). Para cambiar un
   rol hace falta poder con el rol **de antes y con el de después**: un administrador no puede ascender a nadie a
   administrador. Ver la lista de personas es de la gerencia; un cajero no administra a nadie.
9. **Cambiar a una persona** es `PATCH /v1/users/{userId}` con el nombre, el rol o el alta (`active`). Dar de baja marca
   `deactivated_at`, no borra nada (hay historia que apunta a la persona) y vale desde la siguiente petición de esa
   persona (ADR 0022, punto 6). Dar de baja una invitación pendiente la revoca.
10. **Nunca sin un dueño activo.** La regla vive en el caso de uso y se hace valer con un candado: antes de mirar a la
    persona, se leen y se **bloquean (`FOR UPDATE`) los dueños activos, en orden de id**. Dos cambios simultáneos sobre
    los dos últimos dueños se turnan y el segundo ve lo que dejó el primero. Se probó con PostgreSQL real: quince
    rondas de dos dueños dándose de baja a la vez terminan siempre con uno activo. No hay disparador en la base (ver
    «Alternativas»).
11. **Toda entrada se valida en el dominio y se contesta completa.** Un lector de entradas
    (`src/domain/model/validation.ts`) recorre el cuerpo campo por campo y devuelve **todos** los problemas juntos, cada
    uno con su puntero JSON (RFC 6901), un código estable y una frase en español: `400 validation-failed` con
    `errors[]`. Rechaza los campos que no conoce (un error de tipeo no pasa en silencio), los caracteres de control y los
    nombres heredados como `constructor`. Los casos de uso reciben lo que mandó el cliente **sin validar**: ningún
    endpoint puede olvidarse de hacerlo.
12. **Las listas paginan por cursor opaco** (ADR 0019): el cursor lleva la posición `(nombre, id)` en base64url; el
    cliente lo devuelve tal cual. Un cursor que el servidor no hizo se rechaza sin decir qué le faltaba.
13. **Estas operaciones no llevan `operationId`.** La idempotencia por operación (ADR 0019) es de la sincronización; abrir
    un negocio o invitar es administración, solo con conexión y sin cola. Repetir una invitación crea otra, y la
    primera se revoca o vence.

## Alternativas consideradas

### Invitar por correo

Es lo que la gente espera. Pero el correo integrado de Supabase envía **2 por hora** (ADR 0022), un servicio propio de
correo exige un dominio y su reputación, y el dueño del proyecto aceptó explícitamente el código. El código se entrega
a mano (en persona o por el chat que ya usan), que es como se organiza un negocio pequeño.

### Un código corto de seis dígitos

Se dicta mejor, pero tiene un millón de posibilidades y la API no limita intentos. Con ochenta bits no hay nada que
limitar para que adivinar sea inviable.

### Una invitación como token firmado

Evitaría guardar nada, pero no se podría revocar ni renovar ni mostrar en la lista de personas pendientes. La fila
pendiente ya existe (ADR 0021, punto 9).

### Una tabla de invitaciones aparte

El ADR 0021 decidió que no: una restricción exige que cada persona o esté ligada a una identidad o sea una invitación
completa, y no hay dos listas que sincronizar.

### Un disparador que impida quedarse sin dueño

Sería la garantía más fuerte, pero tendría que diferirse (un negocio recién creado tiene su dueño en la misma
transacción que el negocio) y obligaría a que todas las siembras de pruebas y las migraciones futuras lo respeten. El
candado más la prueba de carrera dan la misma garantía para todo lo que pasa por la API, que es lo único que escribe.
Si algún día otro proceso escribe en `app_user`, habrá que reabrir esta decisión.

### Que un administrador pueda invitar administradores

El ADR 0017 lo decidió así (no es configurable): administrar administradores es del dueño.

### Una política de actualización de columnas limitadas para el canje

La seguridad por fila no restringe columnas. La política garantiza **qué fila** y **a qué identidad**; qué columnas
cambia la actualización lo garantizan la API y su prueba. Un procedimiento `SECURITY DEFINER` lo cerraría del todo, a
cambio de más código en la base que revisar; no se justifica mientras la aplicación sea el único escritor.

## Consecuencias

### A favor

- Quien canjea ve y toma **una** fila, la del hash que conoce, vigente y sin canjear; no puede ver ni tocar a nadie más.
  Pruebas de SQL con el rol real lo recorren, incluido qué pasa sin hash, con otro hash, vencida, dada de baja, ligada a
  otra identidad o cuando alguien que conoce el hash intenta cambiar el rol de la invitación sin canjearla.
- La base nunca contiene un código de invitación, solo su hash; lo que se filtre de ella no sirve para entrar.
- Todo error de una petición llega completo y con su puntero: un formulario puede marcar todos los campos de una vez.
- Los permisos de administración son los del ADR 0017 sin una sola regla duplicada, y cada una tiene una prueba en
  negativo.
- El negocio nunca se queda sin dueño por una carrera, probado contra una base real.

### En contra

- **Una persona, un negocio.** Quien administre dos negocios necesita dos cuentas.
- **El código se entrega a mano** y queda en el historial del chat por el que se envíe. Vale siete días y se renueva.
- **La API no limita los intentos de canje.** Con ochenta bits no es adivinable, pero un cliente puede martillar el
  endpoint; el límite de tasa por IP queda para antes de producción.
- **La seguridad por fila no restringe columnas:** que el canje solo cambie la identidad, el hash, el vencimiento y el
  correo depende de la API y de su prueba.
- **El último dueño depende de que todo el que escriba use el candado.** No hay una garantía en la base.
- **Sin transferencia de propiedad guiada:** para cambiar de dueño se nombra un segundo dueño y el primero se retira
  por sí mismo.
- **El hash del código es único en toda la base**, y la tabla de personas tiene ahora cuatro políticas que hay que
  revisar juntas (hay una prueba que lista exactamente cuáles son).
