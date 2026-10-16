# ADR 0006 — Stack y versiones

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 0

## Contexto

Partimos del stack de VSD Health porque ya lo conocemos. Antes de fijarlo comprobamos contra el registro de
npm y de Node las versiones vigentes al **2026-10-16** (ticket C0-01), porque en Health ya nos costó tiempo
asumir que «la última» era la correcta.

## Decisión

### Backend

| Pieza                                    | Versión                      | Nota                                                  |
| ---------------------------------------- | ---------------------------- | ----------------------------------------------------- |
| Node                                     | 24 (LTS 24.22.0)             | `.nvmrc` y `engines: >=24`                            |
| TypeScript                               | **`~6.0.3`**                 | Fijada; ver abajo                                     |
| NestJS (sobre Express)                   | 12.1.x, módulos ESM          | Se añade a mano, sin `nest new`                       |
| Prisma (CLI y cliente)                   | **7.10.1** exacta            | Los dos juntos; ver abajo                             |
| PostgreSQL                               | 17 (la de Supabase)          | Se confirma al crear el proyecto de PRE en el Ciclo 4 |
| Zod / class-validator                    | 4.6.x / 0.15.x               | Solo en adaptadores de entrada                        |
| Vitest                                   | 5.0.x                        | ADR 0007                                              |
| ESLint / typescript-eslint               | 10.12.x / 8.71.x             | ADR 0002                                              |
| Prettier, Husky, lint-staged, commitlint | 3.9.x, 9.1.x, 17.6.x, 21.2.x | Calidad en el commit y en el CI                       |

### Frontend

| Pieza                    | Versión                       | Nota                                         |
| ------------------------ | ----------------------------- | -------------------------------------------- |
| React / Vite             | 19.3.x / 8.3.x                | TypeScript igual que el backend: `~6.0.3`    |
| Tailwind CSS             | 4.3.x con `@tailwindcss/vite` | ADR 0008                                     |
| `framer-motion`          | 14.3.x                        | ADR 0008                                     |
| `react-router-dom`       | 7.x (como Health)             | Pasar a la 8 requiere su propio ADR          |
| `idb`                    | 8.0.x                         | Envoltorio de IndexedDB (no Dexie), ADR 0009 |
| `vite-plugin-pwa`        | 2.0.x                         | Declara compatibilidad con Vite 8            |
| Vitest y Testing Library | 5.0.x y 16.3.x                | ADR 0007                                     |
| Lighthouse CI            | `@lhci/cli` 0.15.x            | Accesibilidad en el CI                       |

### Reglas de versionado

- Gestor de paquetes: **npm**, con `package-lock.json` versionado. El lock fija las versiones exactas; este
  ADR fija las mayores y las excepciones.
- **TypeScript queda en `~6.0.3`, no en `^`.** `npm` instala por defecto la 7.0.2, pero `typescript-eslint`
  declara `typescript >=4.8.4 <6.1.0`; con `^` entraría la 6.1 en cuanto exista y rompería el lint.
- **Prisma queda en 7.10.1 exacta, CLI y cliente.** La etiqueta `latest` del CLI apunta hoy a una versión de
  prueba (`8.0.0-rc.23`) mientras el cliente está en 7.10.1; mezclarlos o usar la de prueba es un riesgo
  que no tomamos.
- **Animación: `framer-motion`.** `motion` 14.3.0 existe y se publica a la par, y ninguno está marcado como
  obsoleto. Seguimos con `framer-motion`, que es lo que usa Health; cambiar después solo toca los imports.

## Alternativas consideradas

- **TypeScript 7:** descartada hasta que `typescript-eslint` la soporte.
- **Prisma 8 (versión de prueba):** descartada hasta que sea estable.
- **pnpm o yarn:** sin ventaja que justifique cambiar lo que el equipo ya domina.
- **Jest:** ver ADR 0007.

## Consecuencias

### A favor

- Versiones comprobadas y las excepciones explicadas, no heredadas por costumbre.

### En contra

- Quedarnos en TypeScript 6 y Prisma 7 nos deja atrás de lo último durante un tiempo.
- Esta tabla envejece: Dependabot avisa de vulnerabilidades, pero no de que un ADR dejó de ser cierto.

### Mitigación acordada

Cuando `typescript-eslint` soporte TypeScript 7 o Prisma 8 sea estable, escribimos un ADR nuevo que reemplace
a este. Quien cambie una versión mayor actualiza el ADR en el mismo PR.
