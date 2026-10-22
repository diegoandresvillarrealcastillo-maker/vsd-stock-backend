# Cómo contribuir al backend de VSD Stock

Esta guía resume el flujo. Las decisiones y su porqué están en el
[ADR 0010](docs/adr/0010-flujo-de-trabajo-en-github.md); si algo de aquí lo contradice, manda el ADR. El detalle
de GitHub (tickets, hitos, etiquetas, plantillas, checks exigidos y cómo se revisa) está en la
[guía de GitHub](docs/guia-github.md), y el vocabulario del negocio, en el
[glosario](docs/dominio/glosario.md).

## Antes de empezar

1. **Un ticket por cambio.** Cada trabajo tiene un Issue con el prefijo de su ciclo (`[C1-07] …`), asignado a
   una persona, y se crea **antes** de empezar. Sin Issue no hay rama.
2. **Una rama corta por ticket**, creada desde `desarrollo` actualizado:

   ```bash
   git switch desarrollo && git pull --ff-only
   git switch -c feat/c1-07-descripcion-corta
   ```

   Tipos: `feat`, `fix`, `chore`, `ci`, `docs` y `test`. Nadie escribe directo en `desarrollo`,
   `preproduccion` ni `produccion`: están protegidas.

## Mientras trabajas

- **La prueba va primero.** Escribe la prueba, **ejecútala y comprueba que falla por la razón correcta** (no por
  un error de escritura), y solo entonces escribe el código mínimo que la hace pasar. Deja esa evidencia en el
  PR (ADR 0007).
- **Respeta las capas.** `domain/` no importa nada de afuera; `application/` no importa de `adapters/` ni de
  `infrastructure/`. Si cruzas una frontera, `npm run lint` falla y el mensaje te dice qué hacer (ADR 0002).
- **Si cambias la API**, regenera el contrato y súbelo: `npm run openapi`. El CI falla si `openapi.json` no
  coincide con el código.
- **Si tomas una decisión de arquitectura**, escríbela como ADR en `docs/adr/` en el mismo PR. Un ADR no se
  edita: si la decisión cambia, se escribe uno nuevo que lo reemplaza.
- **Documenta en el mismo PR** lo que cambias. Cambiar el código sin cambiar su documento hace fallar la revisión.

## Comprobaciones locales

Antes de empujar, estas cinco deben pasar (son las del CI):

```bash
npm run lint
npm run format:check      # npm run format lo corrige
npm run typecheck
npm run test:coverage
npm run build
```

Las pruebas de integración necesitan un PostgreSQL real. Hace falta Docker:

```bash
npm run db:up             # arranca la base local (solo escucha en 127.0.0.1)
npm run test:integration  # prepara la base solo: roles, esquema real y migraciones (ADR 0021)
npm run bench:stock       # opcional: mide el costo de la existencia derivada (ADR 0013)
npm run db:down
```

Si cambias el modelo de datos: edita `prisma/schema.prisma`, escribe una **migración nueva** (nunca edites una ya
aplicada; `prisma migrate diff` te da la parte estructural y lo demás va a mano) y corre `npm run test:integration`:
una prueba compara el esquema de Prisma con la base migrada y otra el modelo documentado con las migraciones. Las
migraciones las aplica **una persona** a un ambiente real, con `npm run db:migrate` (ver
[`docs/ambientes.md`](docs/ambientes.md)).

Husky corre ESLint y Prettier sobre lo que cambia antes de cada commit, y valida el mensaje. **No uses
`--no-verify`**: el CI repite todo y no se puede saltar.

### Roturas a propósito con Stryker (C3-17)

Una prueba que pasa no prueba que vigile algo. [Stryker](https://stryker-mutator.io) rompe el código **a propósito**, de a una
cosa por vez (invierte una condición, quita una rama, cambia un `<` por `<=`), corre las pruebas que tocan esa línea y cuenta
cuántas roturas **notó alguna prueba**. Lo que ninguna prueba nota es un hueco: un comportamiento que nadie vigila.

```bash
npm run mutation          # la primera vez, ~5 min con doce núcleos; el informe queda en reports/mutation/mutation.html
```

- **Qué rompe:** solo `domain/` y `application/`, las capas con lógica. No rompe los adaptadores, la infraestructura ni el
  cliente que genera Prisma. Repite solo las pruebas de esas capas y los vectores de cálculo del contrato
  (`vitest.mutation.config.mts`); las de integración y las de documentos no vigilan esas capas.
- **Cómo leer el informe:** abre `reports/mutation/mutation.html`. Cada rotura queda _muerta_ (una prueba la notó), _sobrevivió_
  (ninguna la notó: falta una prueba o el código sobra), _sin cobertura_ (ninguna prueba pasa por ahí) o _tiempo agotado_
  (la rotura hizo que el código se colgara, y cuenta como notada). Empieza por las que sobrevivieron.
- **Puntaje:** el porcentaje de roturas notadas. La base de `desarrollo` dio **87,50 %** (2.878 notadas, 389 sobrevivientes y 22
  sin cobertura, de 3.289). Verde desde 90 %, aviso por debajo de 87 % y **rojo por debajo de 85 %** (`thresholds` en
  `stryker.config.json`). El piso se sube a medida que se cubren los huecos; nunca se baja para que pase.
- **Qué son los sobrevivientes de hoy:** 216 de los 411 son el cambio de un texto, casi todos el mensaje o la etiqueta de un
  error que ninguna prueba compara palabra por palabra; y varios de los demás son filtros opcionales de las listas (con o sin
  la clave `undefined` el resultado es el mismo). Son los primeros candidatos a _equivalentes_. Antes de darlos por
  equivalentes, mira el informe: cada uno dice qué se cambió y en qué línea.
- **Es incremental:** Stryker guarda lo que aprendió en `reports/stryker-incremental.json` y la siguiente corrida solo repite lo
  que cambió (el código roto o las pruebas que lo tocan). Con nada que repetir, `npm run mutation` tarda unos 25 segundos.
  Para empezar de cero, borra ese archivo. En el CI la memoria se guarda en la caché del repositorio: la corrida de un PR parte
  de la de su rama y, si no hay, de la de `desarrollo`.
- **En el CI** corre como el trabajo **«Roturas a proposito (Stryker)»** y guarda el informe como artefacto
  (`informes-roturas`). Por ahora **no es obligatorio**: no está en el conjunto de reglas de las ramas y no bloquea ningún PR
  hasta que Diego lo marque. Aun así queda en rojo si el puntaje baja del piso: es una señal, no un adorno. Y recuerda que
  **un check del CI es su nombre**: renombrarlo equivale a quitar el check exigido.
- **Cuando cambias `domain/` o `application/`,** corre `npm run mutation` y mira solo lo que tocaste:
  `npx stryker run --mutate "src/domain/model/mi-archivo.ts"` tarda un par de minutos.
- **Una rotura que sobrevive y es equivalente** (cambia el código pero no el comportamiento) se deja y se anota en el PR; no se
  escribe una prueba que fuerce un detalle sin importancia.
- **Por qué existe `scripts/mutation.ts`:** el runner de Vitest de Stryker 10.0.0 es anterior a Vitest 5 y busca cada prueba por su
  nombre con los nombres unidos por espacios, mientras Vitest 5 los une con « > ». No encuentra ninguna, no corre ninguna prueba y
  todas las roturas «sobreviven» (puntaje 0 con un código bien probado). El script repara esa línea del runner antes de correr y se
  detiene si el runner cambia. Cuando Stryker publique un runner con soporte para Vitest 5, se borran el script y su prueba y el
  script `mutation` vuelve a ser `stryker run`.
- **Por qué `package.json` tiene `overrides`:** Stryker trae `typed-rest-client`, que fija `qs` en una versión con avisos de
  seguridad (`npm audit`). El `overrides` sube solo esa dependencia a `^6.16.1`; si Stryker la actualiza, se borra.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/) **en español, en plural, con tildes** y tono
profesional. El encabezado, de hasta 100 caracteres y sin punto final; cada línea del cuerpo, de hasta 100. Cada
commit cita su Issue con una línea `Refs: #N`:

```
feat(health): sumamos GET /health con el esqueleto hexagonal

Cuerpo opcional que explica el porqué.

Refs: #4
```

**Sin líneas `Co-Authored-By` ni marcas de «generado con…»**, en commits ni en PR.

## Pull Request

1. Abre el PR contra **`desarrollo`** (la rama por defecto del repositorio es `produccion`, así que indica la
   base de forma explícita). Usa la plantilla.
2. **Queda en borrador hasta que el CI esté en verde.** Después lo marcas como listo y pides la revisión.
3. **Quien abre un PR no lo aprueba ni lo fusiona.** Lo revisa y lo fusiona la otra persona del equipo, con
   «Create a merge commit». Si pide cambios, se corrigen en el mismo PR.
4. **El backend se fusiona antes que el frontend que depende de él.**
5. Al fusionar, la rama se borra sola. Actualiza tu copia: `git fetch --prune` y borra la rama local.

Un PR está **listo** solo si el CI está en verde y no tiene conflictos; el estado `BLOCKED` solo porque falta la
aprobación es lo esperado.

## Seguridad

- **Nada de secretos en el repositorio**: ni claves, ni contraseñas, ni `.env`, ni datos personales. Gitleaks
  revisa todo el historial y un secreto borrado después sigue estando en él.
- **Las migraciones de base de datos las aplica una persona**, nunca un asistente ni el CI sobre un ambiente.
  Una migración ya aplicada no se edita: el ajuste va en una nueva.

## Trampas conocidas del entorno

- **Windows y PowerShell 5.1:** al pasar texto por una tubería antepone un carácter invisible (BOM) y commitlint
  lo rechaza con «header must not start with whitespace». Escribe el mensaje en un archivo y usa
  `git commit -F archivo`.
- **`npm` en Windows es `npm.cmd`:** con `Start-Process` hay que lanzar `npm.cmd`.
- **Límite de Docker Hub:** si el CI falla con `toomanyrequests`, relanza solo lo que falló:
  `gh run rerun <id> --failed`.
- **Husky tras `npm install <paquete>`:** si los hooks no se activan, ejecuta `npm run prepare`.
