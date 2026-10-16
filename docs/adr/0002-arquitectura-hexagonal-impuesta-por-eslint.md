# ADR 0002 — Arquitectura hexagonal impuesta por ESLint

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 0

## Contexto

La versión anterior de VSD Stock no tenía una arquitectura que pudiera comprobarse: las capas se mezclaban y
nada impedía que una regla de negocio dependiera de un framework. En VSD Health aprendimos que un acuerdo
escrito no basta: con el tiempo alguien importa lo que no debe, y solo una herramienta que **rompe el build**
lo detiene.

## Decisión

Arquitectura hexagonal en ambos repositorios, con la **regla de dependencia siempre hacia adentro**:

`infrastructure` y `adapters` → `application` → `domain`

- `domain/` no importa nada de afuera.
- `application/` no importa de `adapters/` ni de `infrastructure/`, ni siquiera en sus pruebas.
- Los **puertos viven dentro de `domain/ports/`** (`in/` para lo que el dominio ofrece, `out/` para lo que
  necesita). Un puerto es parte del contrato del dominio, no una capa aparte.
- Solo `presentation/` del frontend conoce React.

```
src/
├── domain/            model/  services/  ports/{in,out}/
├── application/       usecases/  services/
├── adapters/          in/  out/
├── infrastructure/    config/  main.ts
└── presentation/      (solo en el frontend)
```

### Cómo se impone

- Una configuración de ESLint con **`no-restricted-imports` por carpeta**. Cada regla lleva un mensaje que
  explica qué hacer en lugar de solo prohibir (por ejemplo, «el dominio no puede importar de `adapters/`:
  declara un puerto en `domain/ports/out/` y haz que el adaptador lo implemente»).
- `no-restricted-syntax` impide `require` e `import()` dinámicos en `domain/` y `application/`, que
  `no-restricted-imports` no revisa.
- **Cada frontera tiene una prueba** que ejecuta ESLint sobre un archivo de ejemplo con el import prohibido y
  comprueba que falla con ese mensaje, y sobre uno permitido y comprueba que pasa.
- El `lint` es un trabajo requerido del CI: una frontera cruzada impide fusionar.

## Alternativas consideradas

### `eslint-plugin-boundaries`

Expresa las capas como elementos y una matriz de permisos; es más legible cuando las reglas crecen. Lo
descartamos por ahora porque añade una dependencia y `no-restricted-imports` ya está probada en VSD Health.
Si la matriz de reglas se vuelve difícil de mantener, lo reevaluamos con un ADR nuevo.

### `dependency-cruiser`

Analiza el grafo real de dependencias. Es más potente, pero es otra herramienta y otra configuración para un
equipo de dos personas.

### Convención escrita y revisión

Es lo que falló en la versión anterior. No la aceptamos como único control.

## Consecuencias

### A favor

- Sin dependencias nuevas y con un patrón que el equipo ya conoce.
- El mensaje del error enseña la solución en el momento en que se comete el error.

### En contra

- Los patrones se escriben sobre **rutas**: un alias de importación o una carpeta nueva puede esquivar la regla.
- `no-restricted-imports` mira especificadores, no el grafo real.

### Mitigación acordada

- Usamos rutas relativas. Si algún día se introduce un alias, la regla y su prueba se actualizan en el mismo PR.
- Cada carpeta nueva con frontera trae su regla y su prueba en el mismo PR.
