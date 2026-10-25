# ADR 0035 — El reporte mensual suma lo que dijo cada recibo, deja las anulaciones aparte y corta los meses a hora de Bogotá

- **Estado:** Aceptada
- **Fecha:** 2026-10-23
- **Ciclo:** 4

## Contexto

El [ADR 0032](0032-un-contador-reviso-la-mecanica-del-iva.md) dejó escrito lo que el contador pidió del **reporte mensual**: las ventas por
tarifa (base e IVA al 19 %, al 5 %, exentas y excluidas), las devoluciones y anulaciones del periodo por las mismas tarifas **en renglón
aparte, no netas**, y un resumen por medio de pago. El [ADR 0034](0034-el-tipo-tributario-vive-en-el-producto-y-se-copia-a-la-linea.md)
agregó el dato que faltaba (el tipo tributario de cada línea). Este ADR decide **cómo se arma ese reporte**: de dónde sale cada cifra, a qué
mes pertenece cada venta y cada anulación, y cómo se evita que el reporte diga una cosa y los recibos otra.

Dos cosas pueden salir mal sin que ninguna prueba de montos las vea: **sacar el IVA con otra cuenta que la del recibo** (el mes no cuadraría
con los comprobantes que ya se entregaron) y **cortar el mes en el instante equivocado** (una venta de las 11 de la noche caería en el mes
siguiente). Ambas se deciden aquí.

## Decisión

1. **Un solo recurso:** `GET /v1/reports/monthly?month=AAAA-MM`. El permiso es `report:sales` (ADR 0017): el dueño y la administración lo
   ven; el cajero recibe 403. **Necesita conexión**, como todo reporte. `month` es obligatorio: no hay un mes por defecto.

2. **Siempre los cuatro renglones, en el orden de la declaración:** gravado al 19 %, gravado al 5 %, exento y excluido, aunque el mes no tenga
   ventas (en cero). Cada renglón trae `total` (con el IVA incluido), `base` e `tax`. Un renglón fijo evita que quien lee el reporte tenga que
   decidir si «no aparece» quiere decir cero o quiere decir que falló algo. La sección trae además `count` (cuántas ventas) y sus totales.

3. **El IVA se saca venta por venta, igual que el recibo.** Dentro de cada venta, las líneas de una misma tarifa y tipo se suman **antes** de
   separar el IVA, una vez por venta (ADR 0014), y el reporte **suma lo que dijo cada recibo**. No saca el IVA del total del mes. La diferencia
   es real: dos ventas de $ 1.000 al 19 % dicen $ 160 de IVA cada una, así que el mes dice $ 320; el IVA de un solo total de $ 2.000 sería
   $ 319. Una declaración que no coincide con los comprobantes que se entregaron se discute; la que los suma, no.

4. **A qué mes pertenece cada cosa:**
   - Una **venta** es del mes de su hora efectiva, la `occurred_at` de su operación (ADR 0016): la del dispositivo corregida con la
     diferencia medida contra el servidor, no la de llegada. Una venta hecha sin conexión el 31 y enviada el 2 cuenta en el mes del 31.
   - Una **anulación** es del mes en que se hizo, el `sale_void.created_at` (el instante que el servidor anotó, el mismo que el detalle de la
     venta muestra como `voidedAt`). Anular necesita conexión (ADR 0017), así que no hay desfase entre el acto y el registro. Una venta de
     septiembre anulada en octubre queda en las ventas de septiembre y en las anulaciones de octubre: una anulación va en el mes en que se
     hizo, y el reporte de septiembre no cambia después de entregado.

5. **Los meses se cortan a la medianoche de Bogotá.** Un mes es el intervalo que incluye su primera medianoche de Bogotá y excluye la del mes
   siguiente. Bogotá está en UTC−5 y no cambia de hora en el año, así que esa medianoche son las 05:00 UTC y el corte es una resta fija, sin
   tabla de zonas horarias. La respuesta trae `from` y `to` para que se vea el corte: la última venta del 31 de octubre a las 23:59 es de
   octubre (04:59 UTC del 1 de noviembre) y la primera del 1 de noviembre es de noviembre.

6. **Las anulaciones van en renglón aparte, no netas.** La sección `voids` trae las ventas anuladas en el mes, con los montos y los cobros de
   **la venta que se anuló**, por los mismos cuatro renglones. El reporte no resta nada por su cuenta: `sales` sigue diciendo todo lo vendido
   en el mes, anulado después o no. Es lo que el contador pidió (ADR 0032, punto 2); cómo se presenta el neto en la declaración lo decide
   quien la presenta.

7. **Lo cobrado, por medio de pago.** Cada sección trae los tres medios (`cash`, `card` y `transfer`), siempre y en ese orden, con lo que
   quedó en la caja o en la cuenta: sin el vuelto, como se guarda (ADR 0027). Las anulaciones traen los cobros de las ventas anuladas.

8. **El reporte no guarda nada.** Se calcula al pedirlo, en el dominio, leyendo `sale_line` y `payment` del mes; no hay una tabla de reportes
   que pueda quedar desactualizada. La aritmética es la misma de siempre (`splitTaxIncluded`, ADR 0014), con lo que los vectores de cálculo
   compartidos con el frontend siguen valiendo sin regenerarse.

9. **Lo que el reporte no es:** no es la declaración de impuestos ni la reemplaza, no es una factura electrónica (el ADR 0032 dejó dicho que
   VSD Stock es control interno y que el negocio responde ante la DIAN por su cuenta) y no incluye los impuestos que no son IVA (las
   bolsas plásticas y el consumo siguen pendientes, cada uno con su ADR). Tampoco es el reporte de ganancias ni el de existencias
   (`report:profit`, `report:stock`).

## Alternativas consideradas

### Sacar el IVA del total del mes

Es una sola cuenta y una sola consulta, pero el mes ya no sumaría lo que dijeron los recibos: la diferencia es de unos pesos por mes, y es
justo la que un revisor encuentra. Se descartó por el ejemplo del punto 3.

### Sumar en SQL

Un `GROUP BY` sobre `sale_line` sería más rápido, pero obligaría a repetir en SQL el redondeo por venta (ADR 0014) y dejaría dos lugares que
tienen que decir lo mismo, que es el riesgo que el ADR 0014 evita. Se lee el mes y se suma en el dominio; ver las consecuencias.

### Mostrar solo el neto

Esconde las anulaciones, que el contador pidió ver aparte, y no deja distinguir un mes con muchas anulaciones de uno tranquilo.

### Guardar el reporte cerrado

Congelaría el mes al cerrarlo, pero agrega un estado («cerrado») y una tabla que habría que defender de las ventas que llegan tarde desde un
dispositivo sin conexión. El reporte de un mes ya entregado no cambia por sí solo: las ventas son historia inmutable (ADR 0009 y 0013) y cada
anulación cae en el mes en que se hizo. Si algún día hace falta firmar un cierre, será otro ADR.

### Un reporte por día

Es una pregunta distinta (el arqueo de caja, ADR 0026); el contador pidió el mes.

## Consecuencias

### A favor

- **El mes cuadra con los recibos entregados:** cada cifra es la suma de lo que dijo una venta.
- **Un mes entregado no cambia solo:** una venta pertenece al mes de su hora efectiva y una anulación al mes en que se hizo.
- **Las anulaciones se ven y no se pierden dentro de un neto.**
- **Sin tablas ni migraciones:** el reporte lee lo que ya se guarda.

### En contra

- **Cuesta leer el mes entero:** el reporte lee las líneas y los cobros del mes y los suma en memoria. Para una tienda de cientos de ventas al día son miles de filas por consulta,
  sin problema; con decenas de miles de ventas al mes habría que pasar la suma a SQL repitiendo el redondeo por venta, o guardar totales
  por venta. Hasta ese día no se justifica.
- **Una venta con la hora dudosa** (`clock-skew`, `future`; ADR 0016) cae en el mes de su hora efectiva, que puede no ser la real. El
  reporte no las separa: la bandeja «Requiere atención» (ADR 0027) es donde se revisan.
- **Elegir qué mes cuenta cada cosa es una decisión del equipo,** no una instrucción del contador: el ADR 0032 pide el reporte, no dice
  cómo fechar una anulación. Igual que el resto, **lo valida quien lleva las declaraciones de la tienda antes de operar con ventas
  reales** (ADR 0032, punto 4).
- **No hay neto ni exportación** (CSV o PDF): el contador pidió los datos, no el formato. Quien los quiera en una hoja los copia de la
  pantalla por ahora.
