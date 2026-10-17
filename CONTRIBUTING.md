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
npm run test:integration
npm run bench:stock       # opcional: mide el costo de la existencia derivada (ADR 0013)
npm run db:down
```

Husky corre ESLint y Prettier sobre lo que cambia antes de cada commit, y valida el mensaje. **No uses
`--no-verify`**: el CI repite todo y no se puede saltar.

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
