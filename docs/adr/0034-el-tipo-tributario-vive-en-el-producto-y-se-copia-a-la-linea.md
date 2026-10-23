# ADR 0034 — El tipo tributario (gravado, exento o excluido) vive en el producto y se copia a la línea de venta

- **Estado:** Aceptada
- **Fecha:** 2026-10-23
- **Ciclo:** 4

## Contexto

El [ADR 0032](0032-un-contador-reviso-la-mecanica-del-iva.md) dejó escrito lo que pidió el contador, y entre sus cuatro precisiones la primera es
**distinguir lo exento de lo excluido**: para el cálculo da igual (los dos dan $ 0 de IVA), pero para declarar van en renglones distintos. El
dueño del proyecto decidió hacerlo **al inicio del Ciclo 4, antes de los reportes mensuales y de las ventas reales**.

Hoy el producto y la línea de venta guardan solo la tarifa en puntos básicos (`tax_rate_bp`: 0, 500 o 1900). Dos productos con 0 % no se
distinguen, y **una venta ya registrada con 0 % no se podrá clasificar después**: el dato que falta no está en ninguna parte. Mientras no haya
ventas reales no se pierde nada (PROD está en pausa y PRE trabaja con datos ficticios), pero cada venta real sin el tipo sería una más sin
clasificar.

## Decisión

1. **Tres tipos tributarios:** `taxed` (gravado), `exempt` (exento) y `excluded` (excluido). Los identificadores van en inglés, como `cash`,
   `card` y `transfer`; la interfaz dice _gravado_, _exento_ y _excluido_. En la API el campo es `taxKind` y en la base la columna es
   `tax_kind`.

2. **La regla de compatibilidad con la tarifa:**

   | Tipo       | Tarifa que admite       |
   | ---------- | ----------------------- |
   | `taxed`    | 5 % (500) o 19 % (1900) |
   | `exempt`   | 0 %                     |
   | `excluded` | 0 %                     |

   No existe un «gravado al 0 %»: un 0 % es exento o excluido. La regla la impone el dominio al leer el producto y cada línea de venta (el
   problema cae en `/taxKind`, con el código `tax-kind-rate-mismatch`) y **la impone también la base**, con una restricción en `product` y otra
   en `sale_line` (`product_tax_kind_fits_rate` y `sale_line_tax_kind_fits_rate`), para que una escritura que no pase por el dominio tampoco
   deje una combinación imposible.

3. **Se guarda en el producto y se copia a la línea de venta,** igual que el precio y la tarifa (ADR 0014 y 0027). Una venta que solo apuntara
   al producto cambiaría de tipo si el negocio corrige la clasificación del producto mañana, y entonces los reportes de ayer cambiarían solos.
   La línea guarda con qué tipo se vendió.

4. **Es obligatorio y no tiene valor por defecto.** Crear un producto y cada línea de venta traen el tipo; la columna es `NOT NULL` sin
   `DEFAULT`, así que ninguna escritura queda clasificada porque alguien se olvidó de decirlo. Al **cambiar** un producto el tipo es opcional,
   pero el resultado (lo que ya tenía más lo que cambia) tiene que seguir siendo compatible: pasar un producto exento a 19 % sin cambiarle el
   tipo se rechaza, con el problema en el campo que la persona mandó (`/taxRateBp`, o `/taxKind` si mandó el tipo).

5. **El cálculo del IVA no cambia (ADR 0014).** El tipo no entra en `splitTaxIncluded` ni en `summarizeSale`: el desglose sigue siendo por
   tarifa y los vectores de cálculo compartidos con el frontend siguen valiendo sin regenerarse (`npm run vectors:check` lo comprueba). El
   reporte mensual (C4-R1) agrupará por tarifa **y** tipo leyendo `sale_line`.

6. **La marca `price-differs` también salta si el tipo de la línea no es el del catálogo de hoy.** Un dispositivo que vendió sin conexión con
   un catálogo anterior vendió con el tipo de ese catálogo: la venta se acepta con su tipo y alguien la mira, como ya pasa con el precio y la
   tarifa (ADR 0027). El nombre de la marca no cambia: hoy cubre precio, tarifa y tipo.

7. **Los datos que ya existen** se marcan en la migración `20261023120000_tipo_tributario`: los productos y las líneas con 5 % o 19 % quedan
   **gravados**, y los de 0 % quedan **exentos**. Esto último es **un valor de arranque, no una clasificación:** no hay forma de saber si un
   0 % existente era exento o excluido. Es seguro hoy porque la base de producción no existe todavía y PRE trabaja con datos ficticios (ADR
   0032); quien aplicara esta migración sobre una base con ventas reales tendría que revisar esos 0 % antes con quien lleva la contabilidad. La
   migración no borra ni cambia ninguna otra columna, y la aplica **una persona** (Samuel en PRE), nunca Claude.

   La migración **llena la columna sin `UPDATE`**: agrega una columna generada y le quita la expresión, con lo que queda una columna normal.
   Lo hace así porque `sale_line` es historia inmutable (ADR 0009 y 0013: un disparador rechaza cualquier `UPDATE`, incluso del dueño) y
   porque la seguridad por fila está forzada (ADR 0005: el dueño, sin un negocio fijado, no vería ninguna fila). Lo único que sí actualiza es
   la hora de cambio de los productos: como a todos les nació un dato, las copias de lectura de los dispositivos (ADR 0028) tienen que
   volver a bajarlos, y un teléfono con el catálogo de ayer no sabría el tipo de ninguno.

8. **El contrato:** `taxKind` entra al producto (lo que se lee, lo que se crea y lo que se cambia) y a la línea de venta (lo que se manda y lo
   que se lee), y `openapi.json` queda al día. Es un cambio **incompatible** para quien registre una venta sin mandar el tipo: el servidor no
   lo inventa. El frontend (C4-E1 del frontend) lo manda y decide qué hacer con una venta que ya estaba en la cola de un teléfono antes de la
   actualización.

## Alternativas consideradas

### Deducir el tipo de la tarifa

Imposible para el 0 %, que es justo el caso que el contador pidió separar. Para 5 % y 19 % sí se deduce (siempre es gravado), y por eso esa
parte de la regla de compatibilidad es una restricción y no un dato más.

### Guardarlo solo en el producto y leerlo desde la línea

La línea quedaría reclasificada cada vez que el negocio corrija el producto, y los reportes de meses cerrados cambiarían. Es el mismo motivo
por el que la línea ya copia el precio y la tarifa.

### Un valor por defecto en la columna

Cualquier escritura que olvide el tipo quedaría clasificada sin que nadie lo decidiera, que es lo contrario de lo que se quiere evitar. Sin
valor por defecto, un olvido es un error visible.

### Un cuarto valor «sin clasificar» para lo que ya existe

Es más honesto con el dato, pero agrega un estado que la interfaz y el reporte tendrían que explicar para datos que hoy son ficticios. Si algún
día hubiera ventas reales antes de aplicar esta migración, sería la opción correcta; el ADR queda dicho para ese caso.

### Reemplazar la tarifa por una clase única (`general`, `reduced`, `exempt`, `excluded`)

Es elegante, pero rompe el contrato, las pruebas y los vectores compartidos por un cambio que no toca el cálculo. El tipo y la tarifa
conviven con una regla entre los dos.

### Una tabla de tipos que el negocio pueda administrar

Sobra: la norma define los tipos, no el negocio. Tres valores fijos en el código y en una restricción bastan, y agregar uno exigiría otro ADR.

## Consecuencias

### A favor

- **Desde la primera venta real cada línea dice su tipo,** y el reporte mensual podrá separar lo exento de lo excluido leyendo `sale_line`.
- **La base impide las combinaciones imposibles** aunque alguien escriba sin pasar por la aplicación.
- **El cálculo, los vectores y los desgloses por tarifa no se tocan.**

### En contra

- **El 0 % que ya existe quedó «exento» sin saberlo.** Hoy no importa (datos ficticios); con datos reales sería una clasificación inventada.
- **Es un cambio incompatible del contrato:** quien venda sin mandar `taxKind` recibe un problema de validación. Los teléfonos con ventas en
  cola de una versión anterior necesitan que el frontend las complete.
- **Toda escritura directa en SQL tiene que decir el tipo** (por eso las pruebas de integración que insertan filas a mano se actualizaron).
- **El sistema no sabe qué producto es exento y cuál excluido:** guarda lo que el negocio le dice y valida que sea compatible con la tarifa. La
  clasificación de cada producto la decide el negocio con quien lleve su contabilidad.
- **No resuelve los impuestos que no son IVA** (bolsas plásticas, consumo): siguen pendientes, cada uno con su ADR (ADR 0032).
