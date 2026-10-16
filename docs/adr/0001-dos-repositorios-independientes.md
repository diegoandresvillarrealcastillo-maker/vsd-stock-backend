# ADR 0001 — Dos repositorios independientes unidos por el contrato OpenAPI

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 0

## Contexto

VSD Stock tiene dos piezas desplegables: una API y una PWA. Comparten conceptos de dominio y, sobre todo,
el contrato de la API: la forma de lo que una envía y la otra recibe.

La versión anterior de VSD Stock reunía todo en un solo repositorio, con las capas mezcladas. En VSD Health
trabajamos con dos repositorios y esa separación nos dio despliegues independientes y revisiones más pequeñas.

## Decisión

**Dos repositorios independientes:** `vsd-stock-backend` y `vsd-stock-frontend`, públicos y en la cuenta
de Diego Villarreal.

- El único acoplamiento entre ellos es el **contrato OpenAPI**. El frontend nunca importa código del backend.
- El backend genera `openapi.json` desde su propio código; el frontend deriva de él sus tipos y su cliente.
- El CI del backend falla si el contrato publicado no coincide con el código. El CI del frontend falla si su
  cliente no coincide con el contrato (se implementa en C0-05 y C0-08).
- **El backend se fusiona antes que el frontend que depende de él.**
- Cada repositorio tiene su propia copia del dominio compartido (qué es una venta válida, qué significa cada
  estado). No hay paquete común: el contrato es lo que los une.

## Alternativas consideradas

### Monorepo

Con un solo repositorio, los tipos compartidos viven en un paquete común y el compilador detecta cualquier
desincronización. Lo descartamos porque ya trabajamos con dos repositorios en VSD Health, porque el despliegue
y los permisos de cada parte quedan acoplados y porque el equipo prefiere revisiones separadas por parte.

### Dos repositorios y un tercero para tipos compartidos

Añade un repositorio que versionar y publicar para un equipo de dos personas. Demasiada ceremonia para el
tamaño del proyecto.

### Copiar los tipos a mano

Es la opción más barata y la que más se desincroniza sin que nadie lo note. La descartamos.

## Consecuencias

### A favor

- Cada parte se despliega por separado, sin que un cambio en una dispare el despliegue de la otra.
- Los permisos y el historial de cada repositorio quedan separados.
- El CI de cada repositorio es más pequeño y más rápido.

### En contra

- **Riesgo principal: los tipos se desincronizan.** El backend puede cambiar una respuesta y el frontend seguir
  compilando contra la forma vieja.
- Un cambio que toca las dos partes necesita dos Pull Requests, y fusionarlos en el orden equivocado rompe
  la aplicación.
- **El dominio queda escrito dos veces.** El cálculo de totales, impuestos y redondeo existe en el servidor y
  en el cliente, y la copia del cliente es la que cobra cuando no hay red. Si divergen, el ticket impreso no
  coincide con lo que el servidor registra.

### Mitigación acordada

- El contrato OpenAPI se genera del código y se verifica en el CI de ambos repositorios.
- Para el dominio duplicado diseñaremos en el Ciclo 1 un conjunto de casos de prueba comunes (datos versionados
  en el backend) que los dos repositorios ejecuten, de modo que una divergencia falle en el CI.

Esto no elimina los riesgos, pero los convierte en un fallo de compilación o de CI y no en un fallo en producción.
