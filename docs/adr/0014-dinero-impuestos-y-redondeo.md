# ADR 0014 — Dinero en pesos enteros, IVA incluido y una sola regla de redondeo

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 1

## Contexto

El [ADR 0003](0003-el-dominio-se-escribe-sin-framework.md) dijo que el dinero nunca es un `float` y dejó el
redondeo «para el Ciclo 1». El [ADR 0001](0001-dos-repositorios-independientes.md) reconoció que el cálculo de
totales, impuestos y redondeo **existe dos veces**, en el servidor y en el cliente, y que la copia del cliente es
la que cobra cuando no hay red: si divergen, el ticket impreso no coincide con lo que el servidor registra.

La pregunta 5 del [mapa de contextos](../dominio/mapa-de-contextos.md) quedó abierta: ¿el impuesto va en el
producto o en la línea de venta, y cómo se redondea?

**Decisión del dueño del proyecto (`APROBADO CICLO 1`, 2026-10-16):** los precios son pesos colombianos enteros
con el IVA **incluido**, la tarifa va **por producto** (`0 %`, `5 %` o `19 %`), el negocio de referencia sí maneja
productos con IVA, y la regla de redondeo al desglosar la base gravable debe hacer que **`base + IVA == total`**
sea exacto en pesos enteros siempre.

## Decisión

1. **El dinero es un número entero de pesos colombianos (COP).** Se modela con el objeto de valor `Money`
   (`src/domain/model/money.ts`): inmutable, sin `float`, con un máximo de **±10¹² pesos** que mantiene toda suma
   y todo producto dentro de lo que un `number` representa sin perder un peso. Puede ser negativo (una anulación
   compensa). En JSON viaja como el entero, sin moneda; en la base de datos será un `bigint`. No hay centavos.
2. **La cantidad es un entero de milésimas de unidad**: `1 unidad = 1000`, `1,5 kg = 1500`. Permite vender por
   peso o volumen sin decimales. El máximo es 10⁹ milésimas (un millón de unidades).
3. **El precio de un producto ya incluye el IVA; el sistema lo desglosa, no lo suma.** La tarifa va **en el
   producto**, en puntos básicos (`0`, `500`, `1900`), y **la línea de venta guarda la tarifa y el precio que
   tenían en ese momento**: cambiarlos después no reescribe ventas ya hechas.
4. **Una sola regla de redondeo: al entero más cercano, y la mitad exacta se aleja de cero** (2,5 → 3; −2,5 →
   −3). Se aplica en tres lugares y en ninguno más:
   - el **bruto de una línea**: `precio × cantidad / 1000`;
   - un **descuento porcentual**: `monto × porcentaje / 10 000`;
   - la **base gravable**: `total × 10 000 / (10 000 + tarifa)`.
5. **El IVA no se redondea: es lo que sobra.** `IVA = total − base`. Por construcción `base + IVA == total` en
   pesos enteros, para todo total y toda tarifa, y ninguno de los dos se aleja más de medio peso de su valor
   exacto. Como la regla es simétrica, **la anulación de una venta suma exactamente lo contrario**.
6. **El IVA se desglosa por tarifa sobre la suma de las líneas de la venta, no línea por línea.** Las líneas de
   una misma tarifa se suman y se desglosan una sola vez. El error es de medio peso por tarifa y no por línea;
   cinco líneas al 5 % que suman 800 pesos dan 38 de IVA agrupadas (el exacto es 38,095) y 39 línea por línea.
7. **Los descuentos son por línea, en pesos, con el IVA incluido, y se restan antes de sacar el IVA.** Un
   descuento no puede ser negativo ni pasar del bruto de la línea. Un porcentaje se convierte a pesos con
   `percentOf`. El descuento sobre toda la venta queda fuera de la entrega.
8. **Los vectores de cálculo son compartidos.** [`contract/calculation-vectors.json`](../../contract/calculation-vectors.json)
   reúne los casos que ejecutan el backend y el frontend. Los resultados esperados **no salen del dominio**: los
   calcula [`scripts/calculation-vectors.ts`](../../scripts/calculation-vectors.ts) con aritmética entera exacta
   y la regla escrita aparte, de modo que un error de redondeo no se esconda detrás de un vector que el propio
   dominio produjo. Una prueba exige que el archivo esté al día y que el dominio cumpla cada vector. El frontend
   guarda una copia idéntica y su CI la compara con la del backend, dentro del trabajo «Contrato con el backend»
   que ya existe (ticket C1-03).

### Lo que NO se decide aquí

- **La mecánica del IVA frente a la DIAN es una hipótesis.** Que la factura discrimine el IVA por tarifa, que la
  base sea `precio / (1 + tarifa)` y que el redondeo sea al peso son supuestos razonables, **no verificados con
  la norma ni con un contador**. Las tarifas vigentes (0 %, 5 % y 19 %) tampoco se han contrastado con la fuente
  oficial. Antes de la entrega, quien lleve la contabilidad del negocio de referencia debe confirmarlas. Si la
  norma exigiera otra mecánica (por ejemplo, redondear el IVA por línea), este ADR se reemplaza y los vectores
  se regeneran.
- **La factura electrónica** queda fuera de la entrega (ya estaba decidido).
- **Otros impuestos** (por ejemplo el impuesto al consumo) usan la misma aritmética con otra tarifa; agregar una
  tarifa al catálogo exige su propio ADR.
- **El redondeo del efectivo a múltiplos de 50 pesos**, que algunos comercios aplican al cobrar, no se hace.

## Alternativas consideradas

### Decimales con centavos (`numeric(18,2)`)

La norma ISO 4217 asigna dos decimales al peso colombiano, pero el comercio no cobra centavos. Dos decimales
obligarían a redondear en cada multiplicación y a mostrar `1.000,00` donde nadie lo espera. Nos apartamos de
ese estándar a conciencia; si un negocio necesitara centavos, sería un ADR nuevo y una migración de todos los
montos.

### `float`

Descartado en el ADR 0003: `0,1 + 0,2` no es `0,3`.

### Precio sin IVA y el IVA sumado al final

Es lo que hace una factura de proveedor, pero el cliente de la tienda ve y paga un precio final. El dueño decidió
precios con IVA incluido.

### Redondear la base y el IVA por separado

Parece más fiel, pero **puede sumar un peso de más**: con una tarifa del 2,4 % y un total de 64 pesos, la base
exacta es 62,5 y el IVA exacto 1,5; redondeados cada uno hacia arriba suman 65. Con las tres tarifas del
catálogo esa mitad exacta nunca aparece, y justamente por eso la prueba recorre más de tres mil tarifas: para que una
tarifa futura no lo descubra en producción.

### Desglosar el IVA por línea

Cada línea acumula hasta medio peso de error y la suma se aleja del IVA exacto (el caso de arriba: 39 contra
38,095). Además, el recibo discrimina por tarifa, no por producto.

### Redondeo bancario (la mitad va al par más cercano)

Elimina el sesgo estadístico, pero no es lo que cualquier persona espera al sumar un ticket a mano, y el sesgo de
«la mitad se aleja de cero» sobre pesos enteros es despreciable.

### Una biblioteca de decimales (`decimal.js`)

Una dependencia más en un dominio que debe quedar sin ellas (ADR 0003). El `bigint` del lenguaje alcanza.

## Consecuencias

### A favor

- **`base + IVA == total` siempre**, comprobado para todos los totales de −3 000 a 3 000 con las tres tarifas, y
  para más de tres mil tarifas posibles; y a no más de medio peso del valor exacto.
- Una anulación **no deja diferencias de un peso**: la base y el IVA son el espejo exacto de la venta.
- El cliente y el servidor calculan lo mismo, y el CI de ambos lo comprueba con 105 casos del desglose, 15 del
  bruto de línea, 9 de porcentajes, 10 ventas completas y 17 entradas inválidas.
- Ninguna operación pasa por un `float`: el producto de un precio por una cantidad se hace en `bigint`.

### En contra

- **El dominio sigue escrito dos veces.** Los vectores convierten una divergencia en un fallo del CI, pero solo
  de los casos que cubren: cada regla nueva trae su vector, o puede divergir sin que nadie lo vea.
- **Sin centavos.** Cualquier negocio que fije precios con centavos queda fuera hasta que haya otro ADR.
- **Las tarifas son tres.** El impuesto al consumo, el IVA de un servicio con otra tarifa o un producto mixto
  exigen un ADR y una tarifa nueva.
- **El IVA por producto no suma exactamente el IVA de la venta.** El desglose es por tarifa sobre la suma, así
  que un reporte de IVA por producto puede diferir hasta un peso por tarifa del IVA del recibo. Los reportes
  mínimos de la entrega no lo piden.
- **La mecánica del IVA es una hipótesis** sin verificar con un contador ni con la DIAN, y de ella depende cada
  recibo. Es el riesgo más importante de este ADR.
- Hay un tope de **10¹² pesos** por monto y de **un millón de unidades** por línea. Es mucho más de lo que
  vende una tienda de barrio, pero es un límite.

### Mitigación acordada

- Los vectores y las propiedades (suma exacta, cota de medio peso, espejo de la anulación, monotonía) viven en las
  pruebas del dominio y corren en cada PR de los dos repositorios.
- Verificar la mecánica y las tarifas con quien lleve la contabilidad del negocio de referencia es una tarea
  **de una persona** y queda anotada como pendiente en el cierre del Ciclo 1.
- Quien cambie la regla en el servidor regenera los vectores con `npm run vectors` y el frontend se entera
  porque su CI compara la copia.
