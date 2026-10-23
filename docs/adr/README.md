# Decisiones de arquitectura (ADR)

Un ADR registra **una decisión y por qué la tomamos**, incluidas las alternativas que descartamos.
Sirve para que dentro de seis meses nadie tenga que reconstruir de memoria por qué el proyecto es como es.

Todos los ADR de VSD Stock viven en este repositorio, con una sola numeración, aunque la decisión
afecte al frontend. El repositorio `vsd-stock-frontend` enlaza a esta carpeta en lugar de duplicarla.

## Índice

| ADR                                                                                      | Decisión                                                                                                        | Estado   |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| [0001](0001-dos-repositorios-independientes.md)                                          | Dos repositorios independientes unidos por el contrato OpenAPI                                                  | Aceptada |
| [0002](0002-arquitectura-hexagonal-impuesta-por-eslint.md)                               | Arquitectura hexagonal impuesta por ESLint                                                                      | Aceptada |
| [0003](0003-el-dominio-se-escribe-sin-framework.md)                                      | El dominio se escribe sin framework                                                                             | Aceptada |
| [0004](0004-uuid-como-clave-primaria.md)                                                 | UUID como clave primaria                                                                                        | Aceptada |
| [0005](0005-aislamiento-por-negocio-en-la-base-de-datos.md)                              | El aislamiento entre negocios lo impone la base de datos                                                        | Aceptada |
| [0006](0006-stack-y-versiones.md)                                                        | Stack y versiones                                                                                               | Aceptada |
| [0007](0007-vitest-pruebas-primero-y-cobertura.md)                                       | Vitest, pruebas primero y cobertura mínima                                                                      | Aceptada |
| [0008](0008-tailwind-y-framer-motion.md)                                                 | Estilo con Tailwind y movimiento con Framer Motion                                                              | Aceptada |
| [0009](0009-motor-offline-y-libro-de-movimientos.md)                                     | Motor offline-first y libro de movimientos                                                                      | Aceptada |
| [0010](0010-flujo-de-trabajo-en-github.md)                                               | Flujo de trabajo en GitHub                                                                                      | Aceptada |
| [0011](0011-el-backend-se-empaqueta-como-imagen-de-docker.md)                            | El backend se empaqueta como una imagen de Docker                                                               | Aceptada |
| [0012](0012-cors-con-lista-explicita-de-origenes-y-sin-credenciales.md)                  | CORS con lista explícita de orígenes y sin credenciales                                                         | Aceptada |
| [0013](0013-existencia-derivada-y-venta-como-una-sola-operacion.md)                      | La existencia es un saldo derivado y la venta es una operación                                                  | Aceptada |
| [0014](0014-dinero-impuestos-y-redondeo.md)                                              | Dinero en pesos enteros, IVA incluido y una regla de redondeo                                                   | Aceptada |
| [0015](0015-catalogo-unidades-cantidades-y-codigos.md)                                   | Catálogo sin variantes: unidades, cantidades y códigos                                                          | Aceptada |
| [0016](0016-folios-por-dispositivo-y-hora-corregida.md)                                  | Folios por dispositivo y hora corregida con el servidor                                                         | Aceptada |
| [0017](0017-roles-permisos-y-modo-sin-conexion.md)                                       | Tres roles, permisos por omisión negados y mostrador sin red                                                    | Aceptada |
| [0018](0018-cifrado-local-y-olvido-del-dispositivo.md)                                   | Cifrado de lo guardado en el dispositivo y olvido en un paso                                                    | Aceptada |
| [0019](0019-convenciones-de-la-api.md)                                                   | Convenciones de la API: versión, errores, enteros e idempotencia                                                | Aceptada |
| [0020](0020-se-congela-el-modelo-del-dominio.md)                                         | Se congela el modelo del dominio                                                                                | Aceptada |
| [0021](0021-esquema-real-y-primera-migracion.md)                                         | El esquema real: Prisma, una migración revisada a mano y una base que se prueba tal como es                     | Aceptada |
| [0022](0022-identidad-y-sesion.md)                                                       | Identidad y sesión: quién llama, a qué negocio pertenece y cuánto dura                                          | Aceptada |
| [0023](0023-negocio-personas-e-invitaciones.md)                                          | Negocio, personas e invitaciones: cómo se abre un negocio y cómo se suma gente                                  | Aceptada |
| [0024](0024-base-del-cliente-web.md)                                                     | Base del cliente web: rutas, sesión, cliente de la API y estructura                                             | Aceptada |
| [0025](0025-verificacion-de-pre-contra-supabase.md)                                      | Verificación de PRE contra Supabase real: qué se comprueba y por qué no imprime secretos                        | Aceptada |
| [0026](0026-turnos-de-caja-y-arqueo.md)                                                  | Turnos de caja y arqueo: quién abre, qué pasa con una venta tardía y cómo se cuenta el efectivo                 | Aceptada |
| [0027](0027-registro-de-ventas-y-atencion.md)                                            | Registro de ventas y atención: se acepta siempre, lo raro se marca y alguien lo revisa                          | Aceptada |
| [0028](0028-lote-de-sincronizacion-y-copia-de-lectura.md)                                | Lote de sincronización y copia de lectura: un resultado por operación y datos con su hora                       | Aceptada |
| [0029](0029-almacenamiento-local-de-cada-persona-y-mostrador-sin-conexion.md)            | Almacenamiento local de cada persona: una base cifrada, un mostrador que se reanuda y dos formas de irse        | Aceptada |
| [0030](0030-aplicacion-instalable-motor-de-envio-y-pantalla-que-dice-la-verdad.md)       | La aplicación instalable, el motor de envío y una pantalla que dice la verdad                                   | Aceptada |
| [0031](0031-hosts-de-pre-render-y-cloudflare-pages.md)                                   | Los hosts de PRE: la API en Render y la web en Cloudflare Pages                                                 | Aceptada |
| [0032](0032-un-contador-reviso-la-mecanica-del-iva.md)                                   | Un contador revisó la mecánica del IVA: se mantiene, y quedan cuatro precisiones                                | Aceptada |
| [0033](0033-la-landing-vive-en-sitio-del-frontend-y-se-publica-aparte.md)                | La landing vive en `sitio/` del frontend y se publica como un proyecto aparte                                   | Aceptada |
| [0034](0034-el-tipo-tributario-vive-en-el-producto-y-se-copia-a-la-linea.md)             | El tipo tributario (gravado, exento o excluido) vive en el producto y se copia a la línea de venta              | Aceptada |
| [0035](0035-el-reporte-mensual-suma-lo-que-dijo-cada-recibo-y-corta-a-hora-de-bogota.md) | El reporte mensual suma lo que dijo cada recibo, deja las anulaciones aparte y corta los meses a hora de Bogotá | Aceptada |
| [0036](0036-las-anulaciones-tienen-su-propio-folio-consecutivo.md)                       | Las anulaciones tienen su propio folio consecutivo, sin saltos, que da el servidor                              | Aceptada |

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
