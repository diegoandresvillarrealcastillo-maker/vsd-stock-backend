# ADR 0003 — El dominio se escribe sin framework

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 0

## Contexto

Las reglas de VSD Stock (cuánto vale una venta, cuándo un movimiento deja el stock negativo, qué diferencia
hay entre lo esperado y lo contado al cerrar la caja) son lo más valioso y lo que más cambia con el negocio.
Si dependen de NestJS, Prisma o React, probarlas exige levantar el framework y cambiar de herramienta obliga
a reescribirlas.

## Decisión

**`domain/` se escribe sin framework y sin Node.** No importa NestJS, Prisma, Express, React ni módulos de
Node (`node:*`, `fs`, `crypto`, etc.).

- Las pruebas del dominio se ejecutan sin levantar nada. Lo único que pueden importar de afuera es el
  ejecutor de pruebas.
- Lo que el dominio necesita del mundo entra por **puertos de salida**: repositorios, reloj y generador de
  identificadores. El dominio nunca llama a `Date.now()` ni genera un UUID por su cuenta.
- La validación de la forma de las peticiones (Zod, class-validator) pertenece a los adaptadores de entrada.
  El dominio protege sus propias invariantes en constructores y fábricas.
- **El dinero nunca es `float`.** Se modela con un objeto de valor `Money` que lleva la moneda y guarda
  enteros en la unidad menor. El redondeo se define y se prueba en el Ciclo 1.
- El modelo de dominio no es el modelo de Prisma: el adaptador de persistencia traduce entre los dos.

## Alternativas consideradas

### Entidades con decoradores de class-validator o con los tipos que genera Prisma

Menos código de mapeo, pero acopla el núcleo al framework y a la base. Es exactamente lo que queremos evitar.

### Modelo anémico con las reglas en servicios de NestJS

Es lo más corriente en NestJS, pero esparce las invariantes: cualquier servicio puede dejar una entidad en un
estado inválido.

## Consecuencias

### A favor

- Pruebas rápidas y sin infraestructura, que hacen razonable exigir cobertura alta.
- El dominio puede cambiar de framework o de base sin reescribirse.
- Los errores de redondeo y de moneda se atrapan en un solo lugar.

### En contra

- Más código: hay que mapear entre el dominio, el modelo de persistencia y los DTO.
- El equipo debe resistir la tentación de «usar directamente» el tipo de Prisma porque ya existe.

### Mitigación acordada

Las fronteras las impone ESLint (ADR 0002), de modo que el atajo falla en el CI y no depende de la disciplina.
