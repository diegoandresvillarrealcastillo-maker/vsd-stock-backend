# ADR 0036 — Las anulaciones tienen su propio folio consecutivo, sin saltos, que da el servidor

- **Estado:** Aceptada
- **Fecha:** 2026-10-23
- **Ciclo:** 4

## Contexto

El [ADR 0032](0032-un-contador-reviso-la-mecanica-del-iva.md) dejó escrito lo que pidió el contador, y una de sus cuatro precisiones es que las
**anulaciones tengan un folio consecutivo propio**: hoy una anulación agrega un registro `sale_void` ligado a la venta, y lo único con que se la
nombra es el folio de la venta que anuló. El contador lo pide para que la auditoría de consecutivos **no tenga saltos**: quien revisa las
anulaciones de un mes necesita una serie que pueda recorrer del primero al último y comprobar que no falta ninguno.

El folio de las ventas (ADR 0016) no sirve de modelo: lo pone el dispositivo, **sin conexión**, y por eso es una serie por dispositivo que puede
tener saltos. Anular, en cambio, **necesita conexión** (ADR 0027), así que el servidor puede dar el número en el momento en que acepta la
anulación.

## Decisión

1. **El folio de una anulación es `ANU-000001`:** el prefijo `ANU`, un guion y el número de anulación del negocio con seis cifras como mínimo;
   pasa de un millón sin envolverse (`ANU-1000000`). Lo arma la función `voidFolio` del dominio. Es el folio **de la anulación**, no el de la
   venta: la venta conserva el suyo (`AA-000142`) y la respuesta trae los dos.

2. **El prefijo no se puede confundir con el de una venta.** Ningún código de dispositivo lleva la `U` (el alfabeto del ADR 0016 la deja fuera
   junto con `0`, `1`, `I`, `L` y `O`), así que `ANU` no puede ser el código de un dispositivo: un folio de anulación nunca es igual a uno de
   venta y `Folio.parse` lo rechaza.

3. **El número es una secuencia del negocio, sin saltos, en el orden en que se anotaron las anulaciones.** Lo da el servidor desde un contador
   por negocio, `void_counter` (el mismo patrón de `device_counter`, ADR 0016), **dentro de la misma transacción** que escribe la anulación y
   con el candado de la fila del contador puesto hasta que la transacción termina:
   - las anulaciones de un negocio se turnan; cada una recibe el número siguiente y ninguna se salta uno;
   - **una anulación rechazada no gasta ningún número:** si la venta ya estaba anulada, si falta el turno donde devolver el efectivo o si algo
     más falla, la transacción se deshace y el contador vuelve a donde estaba;
   - **repetir la petición responde con el mismo folio** (la anulación es idempotente por `operationId`, ADR 0019) y no toma otro número.

4. **Dónde queda guardado.** `sale_void.number` es un entero `NOT NULL` sin `DEFAULT`: ninguna anulación queda sin número porque alguien se
   olvidó de dar uno. La base lo hace cumplir con `sale_void_number_unique` (único por negocio) y `sale_void_number_positive` (desde 1).
   `void_counter` guarda el **siguiente** número por dar: su fila nace con la primera anulación del negocio (con 2, porque el 1 ya se dio) y
   `void_counter_positive` impide que baje de 2. Los dos tienen seguridad por fila forzada (ADR 0005), y la aplicación puede leer, insertar y
   actualizar el contador, pero no borrarlo.

5. **El último número es 2 147 483 646** (`MAX_VOID_NUMBER`): el contador guarda el siguiente en una columna `integer`, cuyo máximo es
   2 147 483 647, así que el último que puede dar es uno menos. Un negocio no se acerca a esa cifra; el dominio lo rechaza antes de escribirla.

6. **La serie no vuelve a empezar** (ni por año ni por periodo) y el folio es **único dentro de un negocio**: dos negocios tienen cada uno su
   `ANU-000001`, como dos dispositivos tienen cada uno su serie. Si el contador necesitara reiniciar por periodo o por resolución, sería otro ADR.

7. **El contrato.** La anulación de una venta (`voided`) trae un campo nuevo, `voided.folio`, en todo lo que devuelve una venta: el detalle, la
   lista y la respuesta de anular. Solo se **lee**, no se manda, así que es un cambio **compatible**: quien no lo conoce lo ignora. El
   frontend (C4-A1 del frontend) lo muestra junto al folio de la venta. `openapi.json` queda al día.

8. **Los datos que ya existen.** La migración `20261023130000_folio_de_anulaciones` numera las anulaciones que ya hay, **por negocio y en el
   orden de la hora en que se anotaron y, si empatan, por su identificador,** y deja el contador de cada negocio en el número siguiente al
   último; los negocios sin anulaciones no tienen fila. No cambia ni borra ninguna otra columna, y la aplica **una persona** (Samuel en PRE),
   nunca Claude; PROD sigue en pausa.

   Numerar filas que ya existen exige un `UPDATE` sobre `sale_void`, y `sale_void` es historia inmutable (ADR 0009 y 0013): un disparador,
   `refuse_history_change`, rechaza cualquier `UPDATE`, incluso del dueño. La columna no puede ser generada (una expresión generada solo ve su
   propia fila y el número depende de las demás), así que esta migración es **la única migración que apaga ese disparador**, y lo hace con
   estas reglas: solo dentro de su propia transacción, solo mientras corre el `UPDATE`, que escribe únicamente `number`, y lo vuelve a activar
   antes de terminar. Por la misma razón suelta un instante la seguridad por fila forzada de `sale_void` (`NO FORCE ROW LEVEL SECURITY`): el
   dueño, sin un negocio fijado, no vería ninguna fila. Una prueba de integración aplica la migración como la aplicará la persona, con el rol
   dueño de las tablas y sin privilegios de superusuario, y comprueba que al terminar el disparador está activo y la seguridad por fila
   forzada.

## Alternativas consideradas

### Una secuencia de PostgreSQL

Las secuencias no son transaccionales: un número tomado por una transacción que se deshace no vuelve, y la serie quedaría con saltos, que es
justo lo que el contador quiere evitar. Además habría que crear una por negocio.

### El máximo más uno

Calcular `max(number) + 1` al anular, sin contador, deja que dos anulaciones simultáneas lean el mismo máximo; evitarlo exige un candado sobre la
tabla entera o uno por negocio (que acaba siendo un contador). El contador por negocio ya existe como patrón (`device_counter`).

### Numerarlas al leer

Dar el número con `row_number()` al listar evita la columna, pero el número cambiaría según el orden con que se lea y no habría nada que una
auditoría pudiera señalar como «el que se dio». Además, la hora de una anulación no siempre sigue el orden en que se confirmaron: dos
transacciones simultáneas pueden terminar en otro orden del que empezaron. Un número guardado, dado con el candado puesto, es el orden real
y no se mueve.

### Que el dispositivo ponga el número

Es lo que se hace con las ventas, pero obliga a aceptar saltos y repetidos al sincronizar. Anular exige conexión, así que no hace falta.

### Colgarle un sufijo al folio de la venta

`AA-000142~V` no es una serie: no se puede recorrer del primero al último ni saber cuántas van. Una venta se anula una sola vez, así que no
agrega nada a lo que la anulación ya dice por estar ligada a la venta.

## Consecuencias

### A favor

- **El contador puede recorrer las anulaciones del primer folio al último** y comprobar que no falta ninguno, porque la base lo garantiza.
- **Una anulación se nombra sin ambigüedad** en una nota, en el cierre de caja o frente al contador, sin depender del folio de la venta.
- **El cambio de contrato es compatible,** y el cálculo del IVA, los vectores y los reportes no se tocan.

### En contra

- **Las anulaciones de un negocio se turnan:** el candado del contador se mantiene hasta que la transacción termina. Anular es poco frecuente y
  la anulación es lo último que hace su transacción, así que el costo es pequeño; aun así, es una espera que el folio de las ventas no tiene.
- **La migración apaga un disparador de historia inmutable.** Es acotada y está probada, pero es la única en el repositorio que lo hace y exige
  que la revise quien la aplique. Aplicarla sentencia por sentencia en vez de como un solo script dejaría el disparador apagado si algo
  fallara a la mitad; por eso se aplica con `prisma migrate deploy` y después se comprueba que `refuse_history_change` esté activo.
- **Las anulaciones que ya existen quedan numeradas por la hora en que se anotaron,** que es un orden razonable pero no el que habría dado un
  contador en vivo. Hoy no importa (PRE trabaja con datos ficticios y PROD no existe); con datos reales, el contador debería revisar esa
  numeración inicial.
- **Un negocio puede dar a lo sumo 2 147 483 646 anulaciones.**
- **Un hueco solo puede aparecer si alguien escribe saltándose la aplicación,** y la base impide borrar o editar una anulación; el contador no
  puede bajar ni repetir un número.
