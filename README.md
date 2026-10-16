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

| Variable | Qué es                                                    | Por defecto |
| -------- | --------------------------------------------------------- | ----------- |
| `PORT`   | Puerto en el que escucha la API (entero entre 1 y 65535). | `3000`      |

Si una variable es inválida, la aplicación se detiene al arrancar con un mensaje que la nombra.

## Scripts

| Script                  | Qué hace                                                                   |
| ----------------------- | -------------------------------------------------------------------------- |
| `npm run build`         | Compila a `dist/`.                                                         |
| `npm start`             | Arranca la versión compilada.                                              |
| `npm test`              | Ejecuta las pruebas (Vitest).                                              |
| `npm run test:coverage` | Pruebas con cobertura; falla si `domain/` o `application/` bajan del 80 %. |
| `npm run lint`          | ESLint, incluidas las **fronteras de la arquitectura**.                    |
| `npm run format:check`  | Comprueba el formato con Prettier (`npm run format` lo corrige).           |
| `npm run typecheck`     | Revisa los tipos del código y de las pruebas.                              |

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
- **CI** (GitHub Actions) con tres trabajos requeridos: escaneo de secretos, convención de commits y
  calidad del código (estilo y fronteras, formato, tipos, pruebas con cobertura y compilación).

## Documentación

- Decisiones de arquitectura: [`docs/adr/`](docs/adr/README.md). Todos los ADR del proyecto, también
  los del frontend, viven aquí.
- Flujo de trabajo (ramas, Issues, commits y PR):
  [ADR 0010](docs/adr/0010-flujo-de-trabajo-en-github.md). La guía `CONTRIBUTING.md` llega con el
  ticket C0-05.
