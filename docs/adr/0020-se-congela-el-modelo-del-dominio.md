# ADR 0020 — Se congela el modelo del dominio

- **Estado:** Aceptada
- **Fecha:** 2026-10-17
- **Ciclo:** 1

## Contexto

El Ciclo 0 dejó el glosario y el [mapa de contextos](../dominio/mapa-de-contextos.md) como **hipótesis**: ocho
preguntas abiertas y 31 de los 59 términos del glosario sin decidir. El Ciclo 1 las respondió una por una, cada
respuesta con su ADR y con una prueba contra PostgreSQL real, una simulación o un navegador real
([ADR 0013](0013-existencia-derivada-y-venta-como-una-sola-operacion.md) a
[ADR 0019](0019-convenciones-de-la-api.md)). Los ciclos 2 a 4 construyen encima: la identidad, el catálogo y el
inventario, el punto de venta y la caja, y los reportes. Si el modelo sigue moviéndose mientras se construye, cada
ciclo rehace parte del anterior, y la fecha de entrega (2026-11-16) no se mueve.

Este ADR cierra el ciclo: **congela el modelo para lo que entra en la entrega,** dice qué queda fuera y cómo se
cambia lo congelado.

## Decisión

1. **Siete contextos, congelados con sus fronteras.** Cada uno es un módulo del mismo programa, no un servicio
   (ADR 0001 y 0011), y no importa del interior de otro (ADR 0002):

   | Contexto               | Es dueño de                                                                 |
   | ---------------------- | --------------------------------------------------------------------------- |
   | **Identidad y acceso** | negocio, sucursal, usuario y rol, dispositivo y su código                   |
   | **Catálogo**           | producto, categoría, unidad, precio, impuesto y los códigos                 |
   | **Inventario**         | bodega, proveedor, compra, el libro de movimientos y la existencia derivada |
   | **Ventas**             | venta, línea, pago, descuento y anulación                                   |
   | **Caja**               | turno, arqueo y movimientos de efectivo                                     |
   | **Reportes**           | nada: lee de los demás, sin escribir                                        |
   | **Sincronización**     | la operación, su idempotencia, su hora y su folio                           |

2. **Veinte tablas, con nombre, congeladas.** Están en el [modelo de datos](../dominio/modelo-de-datos.md) con su
   diagrama y sus reglas de nombres (inglés, `snake_case`, singular, claves foráneas compuestas con `id_negocio`,
   dinero y cantidades en enteros). Los esquemas de juguete de los ADR 0013 a 0016 son sus primeros tramos y la
   migración del Ciclo 2 empieza por **apuntar esas mismas pruebas a las tablas reales**.
3. **Las relaciones entre contextos son las del mapa.** Ventas escribe en Inventario y en Caja **en la misma
   transacción que la venta** (ADR 0013), Sincronización entrega operaciones a los tres, y Reportes solo lee.
4. **Se toman aquí cuatro decisiones de alcance** que los ADR anteriores dejaron pendientes:
   - **No hay tabla de clientes** (`customer`): sin fiado no hace falta saber a quién se vende, y así no se guardan
     datos personales de clientes (Ley 1581). Una venta no tiene cliente. Si llega el fiado, llega con su ADR.
   - **Sí hay categorías**, opcionales y de un solo nivel, y **proveedores** con solo nombre y contacto: cuestan una
     tabla pequeña cada una y evitan preguntas en la pantalla de compras y en el catálogo.
   - **Un mínimo de stock opcional por producto** (`min_stock_milli`) para la alerta, que sigue siendo lo primero que
     se recorta si el plazo aprieta.
   - **El descuento es por línea y en pesos;** el descuento sobre toda la venta queda fuera (ADR 0014). Solo el pago
     en efectivo entra a la caja; la tarjeta y la transferencia son un registro manual.
5. **Qué queda fuera, por escrito:** clientes, cuentas por cobrar y por pagar, gastos, conteo físico y devoluciones
   parciales. Su vocabulario sigue en el glosario como _Hipótesis_ y **no tienen tabla**. Una prueba exige que todo
   término que siga siendo hipótesis diga que está fuera de la entrega.
6. **Qué está congelado y qué no.** Congelado: los contextos y sus fronteras, los nombres de las tablas, sus
   relaciones, las reglas de nombres y todo lo que cita un ADR de este ciclo. **No congelado:** las columnas que
   las pruebas no fijan (el esquema real puede agregar columnas sin un ADR nuevo), el reparto de cada contexto en
   carpetas y la forma de las pantallas.
7. **Cómo se cambia lo congelado:** con un ADR nuevo que reemplace a este (o al que corresponda), en el mismo PR
   que el glosario, el mapa y el modelo de datos. Tres pruebas vigilan que esos documentos sigan diciendo lo mismo:
   todo término «Decidido» cita un ADR que existe, el mapa no deja preguntas abiertas y el diagrama dibuja
   exactamente las tablas de la lista, que contiene todas las que construyen las especificaciones ejecutables.

### Lo que el Ciclo 1 no resolvió

El modelo se congela **con estos riesgos abiertos,** cada uno dicho en su ADR y pendiente de una persona o de un
ciclo:

| Riesgo                                                                                                       | ADR  | Quién o cuándo                                                    |
| ------------------------------------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------- |
| La mecánica del IVA y las tarifas frente a la DIAN **no se han verificado** con la norma ni con un contador  | 0014 | Una persona, con quien lleve la contabilidad, antes de la entrega |
| Prisma escribiendo disparadores y migraciones SQL, y el pooler de Supabase con el contexto de la transacción | 0013 | Ciclo 2, con la base real de DEV                                  |
| El cifrado y el almacenamiento solo se verificaron en Chromium; faltan Firefox, Safari y un teléfono real    | 0018 | Ciclo 3, con el motor real                                        |
| 5 minutos, 72 horas, 5 segundos y la deriva de 20 ppm son valores razonables, no medidos                     | 0016 | Se ajustan con datos reales                                       |
| La tabla de permisos no se ha revisado con quien atiende un mostrador de verdad                              | 0017 | Antes de la entrega                                               |
| Las etiquetas de balanza y los códigos de barras locales mal impresos no se soportan                         | 0015 | Se revisa si el negocio de referencia los usa                     |
| El lote de sincronización y la idempotencia en HTTP se decidieron sin un endpoint que los ejerza             | 0019 | Ciclo 3                                                           |

## Alternativas consideradas

### No congelar y seguir ajustando mientras se construye

Es lo que pide la incertidumbre, y es lo que hace que cada ciclo desarme al anterior. Con una fecha que no se
mueve, un modelo que cambia es un plazo que se recorta sin decirlo.

### Congelar también cada columna

Demasiado pronto: sin ver el primer endpoint, congelar las columnas sería adivinar. Se congela lo que ya tiene una
prueba y lo que un cambio rompería en cascada (nombres, relaciones y reglas), y se deja libre el resto.

### Una tabla de clientes desde el inicio

El glosario la describía como opcional. Sin fiado no hay para qué, y cada dato personal guardado obliga a
consentimiento, exportación y eliminación (Ley 1581), que son justamente lo que la entrega deja como deuda.

### Un esquema de PostgreSQL por contexto, o un servicio por contexto

Aísla más, pero complica las migraciones, el pooler y los reportes que cruzan contextos, y el ADR 0001 ya decidió
un solo backend y una sola imagen.

### Dejar el modelo solo en el glosario

Un documento que nadie vigila se desfasa. Por eso hay un modelo de datos con su diagrama y pruebas que lo comparan
con el glosario, el mapa y las especificaciones.

## Consecuencias

### A favor

- Los ciclos 2 a 4 construyen sobre terreno firme, con las tablas ya nombradas y las reglas ya demostradas.
- Las especificaciones ejecutables se vuelven las primeras pruebas de la migración real.
- Nadie puede, por descuido, tratar una hipótesis como una decisión: lo que no entra en la entrega lo dice.
- Cambiar lo congelado es barato (un ADR) pero **no silencioso.**

### En contra

- **Se congeló en tres días y sin un solo endpoint de negocio.** El primer endpoint del Ciclo 2 puede mostrar que
  alguna decisión estaba mal, y entonces habrá que reemplazar un ADR. La regla de cambio existe para eso, pero
  tiene un costo de tiempo que el plazo apenas tolera.
- **Cuatro decisiones de alcance (clientes, categorías, proveedores y el mínimo de stock) se tomaron durante el
  ciclo sin consultarlas,** por instrucción del dueño del proyecto de no interrumpir. Deben revisarse en el cierre.
- **Veinte tablas** es mucho para tres semanas. El orden de recortes sigue siendo el acordado: primero la mascota,
  después los reportes y después las alertas; la calidad no se recorta.
- **El modelo de datos y el esquema de Prisma son dos descripciones** que pueden diverger. Mientras no haya una
  generación automática de una a partir de la otra, la prueba del Ciclo 2 que apunta las especificaciones a las
  tablas reales es lo único que lo vigila.
- **Los riesgos de la tabla de arriba siguen abiertos.** Congelar el modelo no los cierra.

### Mitigación acordada

- El Ciclo 2 abre con la migración real **escrita a partir de las pruebas de este ciclo,** y cualquier desacuerdo
  entre el esquema y el modelo de datos se resuelve con un ADR, no con un ajuste silencioso.
- El cierre del ciclo entrega al dueño la lista de las decisiones de alcance y de los riesgos abiertos, para que las
  confirme o las cambie antes de empezar el Ciclo 2.
