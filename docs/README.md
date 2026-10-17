# Documentación de VSD Stock

Dónde está cada cosa. Los dos repositorios (`vsd-stock-backend` y `vsd-stock-frontend`) tienen su propio
`README.md` y su `CONTRIBUTING.md`; **la documentación que es de todo el proyecto vive aquí**, en el backend,
con una sola numeración de decisiones.

| Documento                                         | Qué responde                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Decisiones de arquitectura (ADR)](adr/README.md) | Qué decidimos, por qué, qué alternativas descartamos y qué perdemos. Un ADR no se edita.              |
| [Glosario del dominio](dominio/glosario.md)       | Cómo se llama cada cosa del negocio, en español y en el código, y qué tan firme es cada término.      |
| [Mapa de contextos](dominio/mapa-de-contextos.md) | En qué partes se divide el sistema, cómo se hablan y qué entra en la entrega.                         |
| [Permisos](dominio/permisos.md)                   | Qué puede hacer cada rol y qué funciona sin conexión (la tabla se compara con el código).             |
| [Plan de ambientes](ambientes.md)                 | Local, DEV, PRE y PROD (en pausa); variables de entorno; los pasos manuales para quien opera paneles. |
| [Guía de GitHub](guia-github.md)                  | Tickets, hitos, etiquetas, plantillas, checks exigidos y cómo se revisa.                              |

**Del backend:** [`README.md`](../README.md) (cómo correrlo y su arquitectura), [`CONTRIBUTING.md`](../CONTRIBUTING.md)
y el contrato [`openapi.json`](../openapi.json).

**Del frontend:** su
[README](https://github.com/diegoandresvillarrealcastillo-maker/vsd-stock-frontend/blob/desarrollo/README.md)
(arquitectura, sistema de diseño, conexión con el backend), su
[CONTRIBUTING](https://github.com/diegoandresvillarrealcastillo-maker/vsd-stock-frontend/blob/desarrollo/CONTRIBUTING.md)
y su
[documento de rendimiento](https://github.com/diegoandresvillarrealcastillo-maker/vsd-stock-frontend/blob/desarrollo/docs/rendimiento.md).
El diseño está en [Figma](https://www.figma.com/design/BDeOxwJeQ3AfUThABfmC3L).

## Reglas de esta carpeta

- **La documentación se actualiza en el mismo PR que el código.** Cambiar el código sin cambiar su documento hace
  fallar la revisión; `test/docs` vigila lo que se puede comprobar sin leer (enlaces, índices, variables de
  entorno y el estado de cada término del glosario).
- **Un documento nuevo se agrega a esta tabla.** Una prueba falla si no está.
- **Español, con tildes.** El código y sus identificadores van en inglés.
