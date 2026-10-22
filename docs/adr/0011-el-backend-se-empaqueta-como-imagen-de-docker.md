# ADR 0011 — El backend se empaqueta como una imagen de Docker

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 0

## Contexto

El backend tiene que correr igual en la máquina de cada integrante, en el CI y, más adelante, en el ambiente
de pruebas (PRE). En VSD Health lo resolvimos empaquetando la API como imagen de Docker (ADR 0018 de ese
proyecto) y funcionó. Todavía no decidimos **dónde** se despliega VSD Stock: eso llega con el ciclo que
prepare PRE y está fuera del alcance del Ciclo 0.

Lo que sí necesitamos desde ya es la certeza de que el backend **se puede empaquetar y arrancar**, para no
descubrirlo el día del despliegue.

## Decisión

El backend se empaqueta como una **imagen de Docker de dos etapas** (`Dockerfile`):

- **Compilar:** `node:24-slim`, `npm ci` con el lock, `npm run build` y `npm prune --omit=dev`.
- **Ejecutar:** `node:24-slim` con solo `dist/`, las dependencias de producción y el `package.json`. **No corre
  como root** (usuario `node`) y declara un `HEALTHCHECK` que consulta `GET /health`.
- Un `.dockerignore` mantiene fuera del contexto los secretos, `node_modules`, las pruebas y la documentación.
- **El CI construye la imagen en cada PR**, arranca el contenedor, espera a que esté sano, comprueba que
  `GET /health` responde y que el proceso no corre como root. Todavía **no se publica** en ningún registro.
- La imagen **no contiene migraciones ni credenciales**: la configuración llega por variables de entorno y las
  migraciones las aplica una persona (ADR 0010).

## Alternativas consideradas

### Desplegar el código fuente con el compilador de la plataforma

Es lo más corto de configurar, pero lo que corre en el servidor depende de la plataforma y no se puede
reproducir igual en local ni en el CI.

### Funciones sin servidor

Evitan administrar un proceso, pero el arranque en frío y los límites de ejecución no encajan con un servicio
al que un punto de venta sincroniza ventas acumuladas.

### Una sola etapa

Más simple, pero la imagen final arrastraría TypeScript, las pruebas y las herramientas de calidad.

## Consecuencias

### A favor

- El mismo artefacto en local, en el CI y en PRE.
- Un contenedor sin privilegios y con una comprobación de salud que cualquier orquestador entiende.
- El CI avisa si el Dockerfile se rompe, antes de que importe.

### En contra

- **La imagen pesa unos 400 MB.** `@nestjs/swagger` declara `typescript` como dependencia de pares y npm no
  permite podarla (24 MB).
- **El límite de descargas anónimas de Docker Hub** puede tumbar el trabajo de la imagen y el de PostgreSQL con
  `toomanyrequests`, como nos pasó en Health.
- Hay que mantener el Dockerfile al día cuando cambie lo que necesita para compilar.

### Mitigación acordada

- Si el trabajo falla por `toomanyrequests`, se relanza solo lo que falló (`gh run rerun <id> --failed`).
- El CI inicia sesión en Docker Hub si el repositorio tiene los secretos `DOCKERHUB_USUARIO` y
  `DOCKERHUB_TOKEN` (los pone una persona); sin ellos, sigue funcionando sin iniciar sesión.
- Dónde se despliega y dónde se publica la imagen se decide en un ADR del ciclo que prepare PRE.
