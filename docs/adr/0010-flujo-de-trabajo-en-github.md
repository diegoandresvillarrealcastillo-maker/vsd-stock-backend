# ADR 0010 — Flujo de trabajo en GitHub

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 0

## Contexto

El proceso de ingeniería es parte de lo que se evalúa, y en VSD Health nos sirvió tener un flujo estricto con
ramas por ambiente, revisión obligatoria y trazabilidad entre ticket, rama, commit y PR. En VSD Stock **no
usamos Jira**: los tickets viven en GitHub. Este ADR adapta el flujo de Health a esa diferencia.

## Decisión

### Ramas y ambientes

```
<tipo>/c0-04-descripcion  →  desarrollo  →  preproduccion  →  produccion
                               DEV            PRE              PROD
```

- Las tres ramas fijas son ambientes. **Nadie escribe directo en ellas**: todo entra por Pull Request. La rama
  por defecto es `produccion`; por eso cada PR indica `--base desarrollo` de forma explícita.
- Una rama corta por ticket, creada desde `desarrollo` actualizado. Tipos: `feat`, `fix`, `chore`, `ci`, `docs`
  y `test`. Se borra al fusionar.
- Promover a `preproduccion` o `produccion` solo con el visto bueno del dueño del proyecto. **PROD queda en
  pausa** hasta que se diga lo contrario. Nunca se borra `desarrollo`.

### Protección (conjunto de reglas «Ramas de ambiente», activo en los dos repositorios)

PR obligatorio, **una aprobación**, descartar aprobaciones al empujar cambios nuevos, resolver las
conversaciones antes de fusionar, sin `force push`, sin borrado y **sin excepciones para nadie**,
administradores incluidos. Se fusiona con «Create a merge commit».

### Tickets

- **GitHub Issues** en el repositorio que corresponda, con el prefijo de ciclo en el título: `[C0-04]`,
  `[C1-07]`. Un hito por ciclo y etiquetas por tipo. Un ticket, una persona, un PR por repositorio.
- El ticket se crea y se asigna **antes** de empezar.

### Commits y PR

- Conventional Commits **en español, en plural, con tildes y tono profesional**; encabezado de a lo sumo
  100 caracteres y líneas del cuerpo de a lo sumo 100.
- Cada commit termina con una línea `Refs: #N` (el Issue del mismo repositorio).
- **Sin líneas `Co-Authored-By` ni marcas de «generado con…»** en commits ni en descripciones de PR.
- Quien abre un PR no lo aprueba ni lo fusiona. **No se fusiona ningún PR antes de que la otra persona lo
  apruebe.** El backend se fusiona antes que el frontend que depende de él.
- Un PR depende de un CI en verde: queda en borrador hasta que lo esté, y se da por **listo** solo con el CI
  en verde y el estado `CLEAN`, comprobados.
- Nunca `--force`, `--no-verify` ni saltarse los hooks. Los conflictos se resuelven en la rama propia trayendo
  `origin/desarrollo` y después se corre la comprobación de tipos.

### Documentación

- **La documentación se actualiza en el mismo PR que el código.** Cambiar el código sin cambiar su documento
  hace fallar la revisión.
- Todos los ADR viven en `docs/adr/` de este repositorio, con una sola numeración.

### Base de datos y secretos

- **Las migraciones las aplica una persona, nunca el asistente.** Una migración ya aplicada no se edita: el
  ajuste va en una nueva. `prisma migrate reset` está prohibido. Antes de migrar se comprueba a qué host apunta
  la conexión. El CI aplica migraciones únicamente a su base desechable.
- Los secretos viven fuera del repositorio. Nadie pega una clave en un chat, un ticket, un PR ni un archivo.

### Alcance

Con una entrega a un mes, el alcance se recorta antes que la calidad. Lo que queda fuera se anota como deuda
con su ADR y no se omite en silencio.

## Alternativas consideradas

- **Jira:** descartado por el equipo; GitHub concentra código y tickets.
- **Una sola rama `main` y ramas por funcionalidad:** más simple, pero no representa los ambientes que el
  curso evalúa ni da dónde probar antes de producción.
- **Fusión con _squash_:** historial más limpio, pero pierde el rastro de la revisión por commit y rompe la
  convención de Health.

## Consecuencias

### A favor

- Trazabilidad completa entre ticket, rama, commit y PR sin una herramienta aparte.
- Nadie, ni el administrador, puede llegar a un ambiente sin revisión.

### En contra

- **La revisión de la otra persona es un cuello de botella.** Con dos personas, todos los PR pasan por la
  misma, y con un mes de plazo ese tiempo de espera pesa más que el de escribir código.
- Los números de Issue son por repositorio: el prefijo `[Cn-NN]` es lo que une un ticket del backend con el de
  su frontend.

### Mitigación acordada

Fijamos ventanas de revisión durante el día y mantenemos los PR pequeños (un ticket, un PR). Las reglas de
protección se endurecen, no se relajan, si el plazo aprieta.
