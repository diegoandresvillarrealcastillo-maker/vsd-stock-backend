# ADR 0005 — El aislamiento entre negocios lo impone la base de datos

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 0

## Contexto

VSD Stock es multinegocio: muchos negocios comparten las mismas tablas. El error más grave posible es que
un negocio vea o modifique los datos de otro. Si el aislamiento depende solo de que cada consulta recuerde
escribir `WHERE id_negocio = …`, basta un olvido para filtrar datos ajenos. En VSD Health resolvimos lo mismo
con políticas de fila (ADR 0010 de ese proyecto) y funcionó.

## Decisión

**Row Level Security en PostgreSQL con un rol de aplicación sin privilegios.**

- Toda tabla con datos de un negocio lleva `id_negocio uuid not null`.
- En esas tablas, RLS está habilitado y además **`FORCE ROW LEVEL SECURITY`**.
- La API se conecta con un rol propio de la aplicación (`stock_app`) que **no es propietario de las tablas, no
  es superusuario y no tiene `BYPASSRLS`**. Las migraciones las aplica una persona con otro rol.
- En cada transacción, antes de cualquier consulta, la API fija el contexto con
  `set_config('app.id_negocio', <uuid>, true)`; el `true` lo hace local a la transacción.
- Las políticas comparan `id_negocio` con `nullif(current_setting('app.id_negocio', true), '')::uuid`, con
  `USING` y `WITH CHECK`. **Sin contexto, la comparación da nulo y la consulta devuelve cero filas, no todas.**
- El negocio sale del **token verificado**, nunca de lo que el cliente declare, y la autorización se decide en
  `application/` (no en el controlador ni en el frontend).
- Las pruebas de integración corren contra **PostgreSQL real** y demuestran que un negocio no ve ni escribe en
  otro, que sin contexto no se ve nada y que el rol de la aplicación no puede saltarse las políticas.

RLS es la **segunda barrera**. La primera es la autorización en `application/`.

## Alternativas consideradas

### Filtrar con `WHERE id_negocio` en cada consulta

Es simple, pero un olvido lo rompe y nada lo detecta. Lo conservamos como práctica, no como control.

### Un esquema o una base por negocio

Aísla más, pero complica las migraciones, el pool de conexiones y los reportes, y no se justifica para
negocios pequeños.

### Políticas basadas en `auth.uid()` con el acceso directo de Supabase

Nuestra API usa Prisma sobre una conexión propia, no el acceso directo del cliente, así que ese mecanismo
no aplica.

## Consecuencias

### A favor

- Un fallo de programación en una consulta no puede filtrar datos de otro negocio.
- El aislamiento se puede probar contra la base real.

### En contra

- **Toda consulta debe ejecutarse dentro de una transacción con contexto.** Hace falta un envoltorio único (la
  unidad de trabajo) y prohibir las consultas fuera de él.
- Las pruebas de integración necesitan una base real y son más lentas.
- Una tabla nueva sin RLS por olvido pasaría desapercibida.

### Mitigación acordada

- El contexto local a la transacción funciona con el pooler de Supabase en modo transacción; las variables de
  sesión no, así que no las usamos.
- Una prueba automática recorre el catálogo de la base y **falla si una tabla con `id_negocio` no tiene RLS
  forzado**.
- Una migración ya aplicada no se edita: el ajuste va en una nueva.
