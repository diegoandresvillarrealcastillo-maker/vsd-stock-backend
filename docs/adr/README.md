# Decisiones de arquitectura (ADR)

Un ADR registra **una decisión y por qué la tomamos**, incluidas las alternativas que descartamos.
Sirve para que dentro de seis meses nadie tenga que reconstruir de memoria por qué el proyecto es como es.

Todos los ADR de VSD Stock viven en este repositorio, con una sola numeración, aunque la decisión
afecte al frontend. El repositorio `vsd-stock-frontend` enlaza a esta carpeta en lugar de duplicarla.

## Índice

| ADR                                                         | Decisión                                                       | Estado   |
| ----------------------------------------------------------- | -------------------------------------------------------------- | -------- |
| [0001](0001-dos-repositorios-independientes.md)             | Dos repositorios independientes unidos por el contrato OpenAPI | Aceptada |
| [0002](0002-arquitectura-hexagonal-impuesta-por-eslint.md)  | Arquitectura hexagonal impuesta por ESLint                     | Aceptada |
| [0003](0003-el-dominio-se-escribe-sin-framework.md)         | El dominio se escribe sin framework                            | Aceptada |
| [0004](0004-uuid-como-clave-primaria.md)                    | UUID como clave primaria                                       | Aceptada |
| [0005](0005-aislamiento-por-negocio-en-la-base-de-datos.md) | El aislamiento entre negocios lo impone la base de datos       | Aceptada |
| [0006](0006-stack-y-versiones.md)                           | Stack y versiones                                              | Aceptada |
| [0007](0007-vitest-pruebas-primero-y-cobertura.md)          | Vitest, pruebas primero y cobertura mínima                     | Aceptada |
| [0008](0008-tailwind-y-framer-motion.md)                    | Estilo con Tailwind y movimiento con Framer Motion             | Aceptada |
| [0009](0009-motor-offline-y-libro-de-movimientos.md)        | Motor offline-first y libro de movimientos                     | Aceptada |
| [0010](0010-flujo-de-trabajo-en-github.md)                  | Flujo de trabajo en GitHub                                     | Aceptada |

## Reglas

- **Un ADR no se edita.** Si la decisión deja de ser válida, escribimos un ADR nuevo que la reemplaza
  y el viejo pasa a estado _Reemplazada_, con un enlace al que lo sustituye.
- Estados posibles: _Propuesta_, _Aceptada_, _Reemplazada_ y _Rechazada_. **La aceptación es la
  fusión del Pull Request** que lo introduce, aprobado por la otra persona del equipo: hasta
  entonces lo escrito es una propuesta, aunque el archivo diga _Aceptada_.
- Formato: contexto, decisión, alternativas consideradas y consecuencias.
- Las consecuencias incluyen **lo que perdemos**, no solo lo que ganamos. Un ADR sin desventajas
  no está terminado.
- Cambiar el código sin cambiar el ADR que lo describe hace fallar la revisión.
