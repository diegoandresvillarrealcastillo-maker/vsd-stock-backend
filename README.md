# vsd-stock-backend

API y dominio de **VSD Stock**: inventario, punto de venta, caja y reportes para MiPymes.

> **Estado: Ciclo 0 (fundaciones).** Hoy el servicio solo expone `GET /health`. Es el esqueleto con
> las cuatro capas, las fronteras impuestas por ESLint y el CI; la funcionalidad de negocio llega
> en los ciclos siguientes.

## Requisitos

- Node 24 (la versión exacta está en `.nvmrc`) y npm.

## Primeros pasos

```bash
npm ci
npm run build
npm start
```

El servicio escucha en el puerto 3000 (o en el de `PORT`). Para comprobarlo:

```bash
curl http://localhost:3000/health
```

Responde `200` con un JSON como `{"status":"ok","timestamp":"2026-10-16T19:51:35.286Z"}`.

## Configuración

`npm start` lee un archivo `.env` si existe (opción nativa de Node, sin dependencias). Copia
`.env.example` como `.env` y ajústalo. **El `.env` no se sube nunca al repositorio.** Una variable
ya definida en el entorno tiene prioridad sobre la del archivo.

| Variable                 | Qué es                                                                                                         | Por defecto |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- | ----------- |
| `PORT`                   | Puerto en el que escucha la API (entero entre 1 y 65535).                                                      | `3000`      |
| `CORS_ORIGINS`           | Orígenes, separados por comas, a los que se les permite leer las respuestas desde un navegador.                | ninguno     |
| `DATABASE_MIGRATION_URL` | Conexión del rol **dueño** de las tablas, solo para `npm run db:migrate` y el CLI de Prisma. La API no la lee. | ninguno     |

Si una variable es inválida, la aplicación se detiene al arrancar con un mensaje que la nombra.

`DATABASE_MIGRATION_URL` es la única que lleva una contraseña en un ambiente real: va en tu `.env` y nunca en un
chat, un Issue, un PR o un archivo del repositorio. Para la base local de Docker no hace falta (`npm run db:prepare`).

### CORS: qué origen poner

El navegador solo deja que una página lea las respuestas de la API si ésta nombra el origen de la página. Para
trabajar con el frontend local (`npm run dev` en `vsd-stock-frontend`) pon
`CORS_ORIGINS=http://localhost:5173`, que ya viene en `.env.example`.

- Cada origen se escribe como lo envía el navegador: `esquema://host[:puerto]`, en minúsculas, **sin ruta ni
  barra final** (`https://stock.example.com`, no `https://stock.example.com/`).
- **No existe el comodín `*`**: un valor mal escrito o el comodín detienen el arranque.
- Sin la variable no se permite ningún origen. Si el frontend muestra «sin conexión» con la API en pie, lo
  primero que hay que mirar es esto; el arranque registra qué orígenes permite.
- Decisión y alternativas: [ADR 0012](docs/adr/0012-cors-con-lista-explicita-de-origenes-y-sin-credenciales.md).

## Scripts

| Script                     | Qué hace                                                                   |
| -------------------------- | -------------------------------------------------------------------------- |
| `npm run build`            | Compila a `dist/`.                                                         |
| `npm start`                | Arranca la versión compilada.                                              |
| `npm test`                 | Ejecuta las pruebas (Vitest).                                              |
| `npm run test:coverage`    | Pruebas con cobertura; falla si `domain/` o `application/` bajan del 80 %. |
| `npm run lint`             | ESLint, incluidas las **fronteras de la arquitectura**.                    |
| `npm run format:check`     | Comprueba el formato con Prettier (`npm run format` lo corrige).           |
| `npm run typecheck`        | Revisa los tipos del código y de las pruebas.                              |
| `npm run openapi`          | Regenera `openapi.json`, el contrato con el frontend. Súbelo si cambia.    |
| `npm run db:up`            | Arranca un PostgreSQL local con Docker (solo escucha en `127.0.0.1`).      |
| `npm run db:prepare`       | Deja esa base con los roles y el esquema real (migraciones aplicadas).     |
| `npm run db:migrate`       | Aplica las migraciones a `DATABASE_MIGRATION_URL`, tras confirmar el host. |
| `npm run db:check-schema`  | Falla si `prisma/schema.prisma` y la base migrada no dicen lo mismo.       |
| `npm run prisma:generate`  | Regenera el cliente de Prisma (también lo hace `npm ci`).                  |
| `npm run test:integration` | Pruebas contra ese PostgreSQL, en serie. Preparan la base solas.           |
| `npm run bench:stock`      | Mide el costo de la existencia derivada (ADR 0013). No es una prueba.      |
| `npm run vectors`          | Regenera los vectores de cálculo compartidos con el frontend (ADR 0014).   |
| `npm run vectors:check`    | Falla si `contract/calculation-vectors.json` no coincide con su generador. |
| `npm run db:down`          | Apaga la base local.                                                       |

## Base de datos y migraciones

El modelo de datos está congelado ([ADR 0020](docs/adr/0020-se-congela-el-modelo-del-dominio.md)) y vive en dos
lugares que una prueba obliga a coincidir ([ADR 0021](docs/adr/0021-esquema-real-y-primera-migracion.md)):
[`prisma/schema.prisma`](prisma/schema.prisma), que usa el código, y las migraciones de
[`prisma/migrations`](prisma/migrations), SQL que contiene además lo que Prisma no expresa (restricciones, seguridad
por fila, disparadores, permisos).

- **Cliente de Prisma:** se genera en `src/generated/` (no se versiona) con `npm ci` o `npm run prisma:generate`.
- **Pruebas de integración:** `npm run db:up` y `npm run test:integration`. Antes de correr, borran y recrean el esquema
  `public` de la base local de pruebas y le aplican las migraciones reales con Prisma; se **niegan** a hacerlo contra
  cualquier base que no sea local y cuyo nombre no termine en `_test`.
- **Un ambiente real** (PRE, y PROD cuando se levante la pausa): las migraciones las aplica **una persona** con
  `npm run db:migrate`, que antes muestra a qué host apunta la conexión (sin la contraseña) y pide escribirlo. Los
  pasos están en el [plan de ambientes](docs/ambientes.md). Una migración aplicada no se edita; el cambio va en otra.
- **Cambiar el modelo:** edita `prisma/schema.prisma`, escribe la migración (`prisma migrate diff` te da la parte
  estructural) y completa a mano lo que Prisma no expresa. Dos pruebas te dicen si las dos descripciones se separaron.

## Arquitectura

Hexagonal, con la dependencia siempre hacia adentro (ADR 0002):

```
infrastructure, adapters  →  application  →  domain
```

```
src/
├── domain/            model/  services/  ports/{in,out}/   ← el núcleo: sin framework ni Node
├── application/       usecases/  services/                  ← orquesta el dominio
├── adapters/          in/http/  out/                        ← controladores, reloj, persistencia…
└── infrastructure/    config/  main.ts                      ← cableado y arranque
```

Cruzar una frontera **rompe el build**: `npm run lint` falla con un mensaje que explica qué hacer, y
`test/architecture/boundaries.spec.ts` comprueba que cada regla se sigue imponiendo.

## Calidad

- **Pruebas primero:** cada pieza nace de una prueba que se vio fallar (ADR 0007).
- **Hooks de Husky:** antes de cada commit se corren ESLint y Prettier sobre lo que cambia, y se
  valida el mensaje con commitlint.
- **CI** (GitHub Actions), siete trabajos:
  - escaneo de secretos (gitleaks sobre todo el historial);
  - convención de commits;
  - calidad del código (estilo y fronteras, formato, tipos, pruebas con cobertura, **contrato OpenAPI al
    día** y compilación);
  - pruebas de integración contra un PostgreSQL real;
  - construcción de la imagen de Docker y comprobación del contenedor;
  - análisis de código con CodeQL;
  - vulnerabilidades de las dependencias de producción.

## Contrato OpenAPI

`openapi.json` es lo único que une a este repositorio con el frontend (ADR 0001). Se genera del código con
`npm run openapi` y se versiona. Una prueba lo compara con lo que produce el código: si cambias la API y no lo
regeneras, falla con un mensaje que dice qué hacer.

## Vectores de cálculo

El dinero, el IVA y el redondeo se calculan en los dos repositorios (el cliente cobra cuando no hay red). Para que
no diverjan, [`contract/calculation-vectors.json`](contract/calculation-vectors.json) reúne los casos que ejecutan
ambos, con resultados que calcula [`scripts/calculation-vectors.ts`](scripts/calculation-vectors.ts) con aritmética
exacta y no el dominio (ADR 0014). **No se edita a mano:** si cambia la regla, `npm run vectors` lo regenera y el
CI del frontend avisa si su copia quedó atrás.

## Docker

```bash
docker build -t vsd-stock-backend .
docker run --rm -p 3000:3000 vsd-stock-backend
```

La imagen no corre como root, trae un `HEALTHCHECK` sobre `GET /health` y no contiene credenciales: la
configuración llega por variables de entorno (ADR 0011).

## Documentación

Todo está indexado en [`docs/README.md`](docs/README.md). La documentación que es de todo el proyecto, no solo
del backend, vive aquí.

- Cómo contribuir (ramas, commits, PR, comprobaciones): [`CONTRIBUTING.md`](CONTRIBUTING.md).
- Decisiones de arquitectura: [`docs/adr/`](docs/adr/README.md). Todos los ADR del proyecto, también
  los del frontend, viven aquí.
- Flujo de trabajo, con su porqué: [ADR 0010](docs/adr/0010-flujo-de-trabajo-en-github.md); y su cómo, en la
  [guía de GitHub](docs/guia-github.md).
- El vocabulario del negocio: [glosario](docs/dominio/glosario.md) y
  [mapa de contextos](docs/dominio/mapa-de-contextos.md).
- Dónde corre cada cosa y qué hay que hacer a mano: [plan de ambientes](docs/ambientes.md).
