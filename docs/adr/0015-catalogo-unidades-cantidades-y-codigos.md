# ADR 0015 — Catálogo sin variantes: unidades, cantidades y códigos

- **Estado:** Aceptada
- **Fecha:** 2026-10-17
- **Ciclo:** 1

## Contexto

La pregunta 1 del [mapa de contextos](../dominio/mapa-de-contextos.md) era si hay variantes de producto o si
una unidad de medida alcanza. Detrás hay otras que el catálogo debe responder antes de que exista una sola tabla:
cómo se cuenta lo que se vende por peso, cómo se escribe y se compara un código de barras, qué hace único a un
producto dentro de un negocio y qué pasa con un producto que ya no se vende.

**Decisión del dueño del proyecto (`APROBADO CICLO 1`, 2026-10-16):** sin variantes ni conversión de empaques en
esta entrega; cada presentación (unidad, paca, caja) es un producto independiente con su propio código.

El dinero ya está decidido ([ADR 0014](0014-dinero-impuestos-y-redondeo.md)) y la existencia es una suma de
movimientos ([ADR 0013](0013-existencia-derivada-y-venta-como-una-sola-operacion.md)). Este ADR decide lo que
falta para describir **qué** se vende y **cuánto**. Su especificación ejecutable es
[`catalog.integration.spec.ts`](../../test/integration/catalog.integration.spec.ts) contra PostgreSQL real, más las
pruebas del dominio en `src/domain/model/`.

## Decisión

1. **No hay variantes ni conversión de empaques.** Un producto tiene un nombre, un SKU, un código de barras
   opcional, **una** unidad de medida, un precio con el IVA incluido y la tarifa de ese IVA. «Gaseosa 350 ml
   unidad» y «Gaseosa 350 ml caja x 12» son dos productos con dos códigos y dos existencias que **no están
   enlazadas**. Abrir una caja es un ajuste de inventario con motivo (−1 caja, +12 unidades), no una conversión.
2. **La unidad de medida es un conjunto cerrado:** unidad (`und`), kilogramo (`kg`), gramo (`g`), libra (`lb`),
   litro (`l`) y mililitro (`ml`). No existen «caja», «paca» ni «docena»: por la decisión 1 serían un producto.
   La unidad de un producto **no cambia una vez que tiene movimientos**, porque reinterpretaría todo su historial;
   esta regla se hace cumplir y se prueba cuando exista el esquema real (Ciclo 2).
3. **La cantidad es un entero positivo de milésimas de su unidad** (`Quantity`): `1 und = 1000`, `1,5 kg =
1500`. La unidad se cuenta **solo en enteros**; el resto admite hasta tres decimales. Lo que escribe una
   persona se lee con un punto o una coma **siempre como separador decimal, nunca de miles**: `1.500` son un
   kilo y medio. Más de tres decimales se **rechazan**, no se redondean en silencio. El máximo es un millón de
   unidades (el de la línea de venta, [ADR 0014](0014-dinero-impuestos-y-redondeo.md)). Un kilo y un litro no se
   suman.
4. **El SKU es obligatorio y único por negocio, sin distinguir mayúsculas.** Son de 1 a 40 caracteres: letras sin
   acento, dígitos y `. _ / -`, en grupos separados por un solo espacio. «Arroz-500» y «ARROZ-500» son el mismo
   código. La clave que se compara (`sku_key`) **la calcula la base de datos**, no la aplicación: no se puede
   olvidar.
5. **El código de barras es opcional y es un GTIN válido.** Son 8, 12, 13 o 14 dígitos (EAN-8, UPC-A, EAN-13,
   GTIN-14) con el **dígito de control comprobado**: es lo que atrapa el error de digitación, y atrapa todo
   cambio de un solo dígito. Un lector de mano agrega un salto de línea y se ignora. El código de todo ceros se
   rechaza.
6. **Su clave de comparación es la forma de 14 dígitos** (con ceros a la izquierda), de modo que el UPC-A
   `036000291452` y el EAN-13 `0036000291452` son el mismo producto. Es única por negocio, y varios productos
   pueden no tener código de barras. También la calcula la base de datos (`barcode_key`).
7. **Un producto no se borra: se archiva, y sigue reservando sus códigos.** Un producto con historial no puede
   desaparecer sin dejar huérfanas ventas y movimientos. Mientras está archivado, su SKU y su código de barras
   siguen siendo suyos, de modo que ningún reporte encuentra dos productos con el mismo código. Para reutilizar
   uno hay que cambiárselo al archivado.
8. **El precio y la tarifa se copian a la línea al vender**, como dice el [ADR 0014](0014-dinero-impuestos-y-redondeo.md).
9. **El dominio valida; la base impone la forma y la unicidad.** `createProduct` rechaza lo inválido con un
   `RangeError` antes de tocar la base; las restricciones `CHECK` y `UNIQUE` repiten la forma (nombre, largos,
   unidades, tarifas, rango del precio) y son lo que impide que un error de código o un script la salten. La
   base **no** comprueba el dígito de control del código de barras: eso vive en el dominio. Las unidades, las
   tarifas y el precio máximo de las restricciones **salen de las constantes del dominio**, no se copian a mano.

### Lo que NO se decide aquí

- **Las categorías** (el glosario las nombra) quedan para el ADR que congela el modelo.
- **Los códigos de balanza** (EAN-13 con prefijo 20 a 29, que llevan el precio o el peso dentro) **no se
  soportan como si fueran un producto**: su significado depende de la balanza, no del producto. Es una
  limitación a conocer si el negocio de referencia pesa con etiqueta.
- **La lectura con la cámara** del dispositivo (la API `BarcodeDetector` no está en todos los navegadores) y los
  atajos del lector se resuelven con la interfaz, en el Ciclo 3. El dominio recibe un texto, venga de donde venga.
- **Los precios por volumen o por presentación** y las promociones.

## Alternativas consideradas

### Producto con variantes (talla, color, presentación)

Es lo que hace falta en una tienda de ropa, pero cada variante necesita su existencia, su código y su precio, y
casi todo el modelo (ventas, movimientos, reportes) pasa a depender de «producto + variante». Para una tienda de
barrio, una presentación distinta **es** otro producto con otro código de barras, y el dueño lo decidió así.

### Conversión entre presentaciones (una caja son 12 unidades)

Ahorra el ajuste manual al abrir una caja, pero obliga a decidir en qué unidad se guarda cada existencia, cómo se
redondean las fracciones y qué pasa con una venta de media caja. Queda fuera de la entrega.

### Cantidades con decimales (`numeric`)

Un `numeric(12,3)` permitiría lo mismo, pero arrastra decimales a cada suma y a cada multiplicación del precio
por la cantidad. El entero de milésimas se multiplica en `bigint` sin pérdida (ADR 0014) y se serializa tal cual.

### Aceptar cualquier cadena como código de barras

Más tolerante con productos locales cuyo código no cumple la norma, pero deja pasar el error de digitación, que
es el fallo más común del ingreso manual. El costo de rechazar es poco: el producto puede registrarse con su SKU
y sin código de barras.

### El código de barras único en todo el sistema

Dos negocios venden el mismo producto con el mismo código, y cada uno tiene su propio catálogo: la unicidad es
por negocio, como todo lo demás (ADR 0005).

### Dejar libre un código al archivar

Permite reutilizarlo sin pasos, pero un mismo código apuntaría a dos productos distintos en el historial y los
reportes tendrían que desambiguar por fecha.

## Consecuencias

### A favor

- Un modelo pequeño: un producto es una fila con un precio, una unidad y un código; lo demás se deriva.
- El error de digitación de un código de barras se detecta al escribirlo, no al venderlo.
- La unicidad no depende de que la aplicación se acuerde: la impone la base, y cada llave la calcula ella.
- El mismo producto no se registra dos veces por escribir su UPC con o sin el cero inicial.

### En contra

- **Sin variantes, el catálogo se llena de productos casi iguales** y no hay un reporte «por modelo». Cambiarlo
  más adelante exige migrar productos, ventas y movimientos.
- **Abrir una caja es un trámite manual** (dos ajustes), y se puede hacer mal: la existencia de unidades y la de
  cajas no se corrigen solas.
- **El dígito de control rechaza códigos locales mal impresos**, que existen. Quien los tenga debe usar solo el
  SKU. Es una decisión consciente a favor de atrapar los errores de digitación.
- **`1.500` se lee como 1,5 y no como mil quinientos.** Es la lectura correcta para una balanza, pero choca con
  quien escribe el punto como separador de miles; la interfaz debe usar un campo numérico que lo evite (Ciclo 3).
- **Las unidades son seis.** Una vara, una arroba o un quintal exigen un ADR.
- **Un producto archivado ocupa sus códigos para siempre**, y el nombre «archivado» no avisa que un SKU está
  reservado: la interfaz debe decir con quién choca.
- **El máximo de un millón de unidades por línea** y de tres decimales es un límite.
- **La regla «la unidad no cambia con movimientos» todavía no está probada**: no existe el esquema que la haga
  cumplir. Es una deuda explícita del Ciclo 2.

### Mitigación acordada

- Las pruebas del dominio incluyen **todas las posibles equivocaciones de un solo dígito** de un código real y los
  largos válidos e inválidos; las de la base recorren la unicidad por negocio, entre mayúsculas, entre UPC y EAN y
  con archivados.
- El Ciclo 2 empieza escribiendo la migración real **a partir de estas pruebas**, apuntadas a las tablas reales.
- Si el negocio de referencia usa etiquetas de balanza o códigos propios inválidos, se revisa este ADR con ese
  caso real antes de la entrega.
