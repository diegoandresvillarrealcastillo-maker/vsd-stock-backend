# ADR 0032 — Un contador revisó la mecánica del IVA: se mantiene, y quedan cuatro precisiones

- **Estado:** Aceptada
- **Fecha:** 2026-10-22
- **Ciclo:** 3

## Contexto

El [ADR 0014](0014-dinero-impuestos-y-redondeo.md) decidió cómo se calcula el IVA y dijo, con todas las letras, que **la mecánica era una
hipótesis sin verificar con la norma ni con un contador**, y que era «el riesgo más importante» de ese ADR. El
[ADR 0020](0020-se-congela-el-modelo-del-dominio.md) lo dejó en su lista de riesgos abiertos: «una persona, con quien lleve la
contabilidad, antes de la entrega».

El 22 de octubre de 2026 el dueño del proyecto le entregó a un contador, como consulta tributaria externa, una hoja con las siete reglas
de cálculo, cinco ejemplos con números y ocho preguntas, y recibió una respuesta por escrito. Este ADR **deja constancia de lo que
contestó** y de lo que pidió, junto con tres decisiones que el dueño del proyecto tomó al leerla. No cambia el cálculo.

## Decisión

1. **La mecánica del ADR 0014 se mantiene sin cambios.** El contador recalculó los cinco ejemplos de la hoja y coinciden con el dominio.
   Estuvo **de acuerdo** en tres preguntas (la fórmula de la base y el IVA por diferencia, el redondeo al peso con desglose por tarifa
   sobre la suma, y restar el descuento antes de sacar el IVA); **de acuerdo con una salvedad** en otras tres (otros impuestos, la
   factura electrónica y las anulaciones); y pidió **ajustes** en dos (separar lo exento de lo excluido y la forma del reporte mensual).
   Ninguna respuesta pide otra fórmula, otro redondeo ni otro orden para los descuentos. **El ADR 0014 y los vectores de cálculo siguen
   vigentes:** este ADR lo complementa, no lo reemplaza, y no cierra la tabla del ADR 0020 editándola (un ADR no se edita): la cierra
   esta constancia.

   | Total cobrado | Tarifa | Base     | IVA     | Base + IVA |
   | ------------- | ------ | -------- | ------- | ---------- |
   | $ 10.000      | 19 %   | $ 8.403  | $ 1.597 | $ 10.000   |
   | $ 11.900      | 19 %   | $ 10.000 | $ 1.900 | $ 11.900   |
   | $ 10.000      | 5 %    | $ 9.524  | $ 476   | $ 10.000   |
   | $ 3.500       | 5 %    | $ 3.333  | $ 167   | $ 3.500    |
   | $ 800         | 5 %    | $ 762    | $ 38    | $ 800      |

   Una prueba (`test/docs/revision-contable.spec.ts`) exige que esta tabla sea lo que calcula `splitTaxIncluded`.

2. **Cuatro precisiones que el contador pide y que hoy no están.** Ninguna cambia el cálculo; cada una necesita su ticket y, si toca el
   modelo, su ADR (el modelo está congelado, ADR 0020):
   - **Distinguir lo exento de lo excluido.** Para el cálculo da igual (los dos dan $ 0 de IVA), pero para declarar hay que separarlos
     en renglones distintos. Hoy el producto y la línea de venta guardan solo la tarifa en puntos básicos (`tax_rate_bp`: 0, 500 o 1900),
     así que **una venta ya registrada con 0 % no se podrá clasificar después.** **El dueño del proyecto decidió hacerlo al inicio del
     Ciclo 4, antes de los reportes mensuales y de las ventas reales:** se agregará el tipo tributario del producto (y se copiará a la
     línea, como ya se copian el precio y la tarifa). Mientras no haya ventas reales no se pierde nada: PROD está en pausa y PRE trabaja
     con datos ficticios.
   - **Anulaciones con folio propio.** Hoy una anulación no borra nada: agrega un registro `sale_void` aparte, ligado a la venta, con su
     fecha, y compensa base e IVA exactos. Lo que no tiene es un **folio consecutivo propio** que referencie el de la venta. El contador
     lo pide para que la auditoría de consecutivos no tenga saltos.
   - **El reporte mensual** (fuera de la entrega) tendrá que separar: ventas por tarifa (base e IVA al 19 %, al 5 %, exentas y
     excluidas); **devoluciones y anulaciones** del periodo, por las mismas tarifas y en renglón aparte, no netas; y un resumen por
     **medio de pago**. Los datos ya están (`sale_line`, `sale_void` con su fecha, `payment`), salvo el tipo tributario.
   - **Impuestos que no son IVA**, solo si la tienda los cobra: el impuesto a las **bolsas plásticas** (un valor fijo por bolsa, no un
     porcentaje) y el impuesto al consumo de las comidas preparadas. Cada uno exige su ADR, como ya decía el ADR 0014.

3. **La factura electrónica sigue fuera de la entrega, y el dueño del negocio tiene que saberlo.** El contador advierte que quien es
   responsable de IVA (cobra 5 % o 19 %) está obligado a expedir factura electrónica de venta o el documento equivalente POS
   electrónico, sin importar el monto, y que el comprobante de VSD Stock sirve para el control interno de caja e inventario. **El dueño
   del proyecto confirmó que la tienda maneja hoy esa obligación ante la DIAN por fuera del sistema** (con el facturador gratuito de la
   DIAN o con su propio proceso externo, cuando aplica). Por eso, en esta etapa, **VSD Stock es solo control interno de inventario y
   cuadre de caja y no reemplaza el documento fiscal.** El comprobante ya lo dice: «Comprobante de venta — no es factura». Si algún día
   se integra un proveedor tecnológico, será otro ADR.

4. **Quién lo dijo y qué se verificó.** Fue una consulta tributaria externa para verificar las fórmulas y las reglas del Estatuto
   Tributario. **En el repositorio consta como «revisión técnica contable externa», sin nombre propio** (decisión del dueño del
   proyecto). No es la validación de quien lleva las declaraciones de la tienda, que era lo que pedía el ADR 0014: **antes de operar en
   vivo con ventas reales, el dueño del proyecto la valida con quien lleva las declaraciones de la tienda.** Las normas que cita
   (artículos del Estatuto Tributario, resoluciones de la DIAN y el valor del impuesto a las bolsas) son suyas: **el equipo no las
   contrastó con la fuente oficial.** La respuesta original la guarda el dueño del proyecto, fuera de Git.

## Alternativas consideradas

### Reemplazar el ADR 0014

El ADR 0014 dice que se reemplaza «si la norma exigiera otra mecánica». El contador no la pide: la aritmética es la que él mismo
recalculó. Reemplazarlo cambiaría un documento que está bien para repetir su texto.

### Editar el ADR 0014 o el 0020 para marcar el riesgo como cerrado

Un ADR no se edita una vez aceptado. La constancia vive aquí; el glosario y el comentario de `TAX_RATES_BP`, que no son ADR, apuntan a
este.

### Agregar el tipo tributario ahora

Es lo que más conviene (punto 2), pero toca el modelo congelado: una migración, el catálogo, la línea de venta y las dos aplicaciones, con su
ADR y su ticket. No cabe en el cierre del Ciclo 3 sin sacar algo: el dueño del proyecto decidió hacerlo al inicio del Ciclo 4 (punto 2).
Queda dicho aquí que **cuanto más tarde, más ventas quedan sin clasificar.**

### Meter la factura electrónica en la entrega

Cambia el alcance que el ADR 0014 ya dejó fuera (integrar un proveedor tecnológico y sus resoluciones es un proyecto aparte). El dueño
del proyecto confirmó que la tienda lleva esa obligación por fuera del sistema (punto 3); este ADR solo se asegura de que nadie dé por
hecho que VSD Stock la cubre.

## Consecuencias

### A favor

- **El mayor riesgo del ADR 0014 tiene ahora el respaldo de una persona que sabe del tema,** y la aritmética fue verificada por separado:
  el contador recalculó los cinco ejemplos.
- Los cuatro pendientes quedan escritos con su porqué y con lo que el código ya tiene, en vez de perderse en una conversación.
- Los vectores de cálculo compartidos con el frontend siguen valiendo: no hay que regenerarlos.

### En contra

- Es **la respuesta escrita de una persona,** no una certificación ni un concepto firmado, y por decisión del dueño del proyecto aquí
  no consta quién es.
- **No es la validación de quien lleva las declaraciones de la tienda,** que el ADR 0014 pedía y sigue pendiente antes de operar con
  ventas reales.
- **Las tarifas y las citas de la norma no se contrastaron** con la fuente oficial; si alguna cambia, este ADR no lo sabrá.
- **Sin el tipo tributario, VSD Stock no puede separar exentos de excluidos,** y cada venta real sin él es una que no se podrá
  clasificar después.
- **La obligación de facturar electrónicamente es un riesgo legal del negocio que use VSD Stock,** no del código. Este ADR solo lo deja
  dicho; no lo resuelve.
