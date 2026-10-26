# ADR 0037 — La marca `future` tolera el error de la propia medición del reloj

- **Estado:** Aceptada
- **Fecha:** 2026-10-25
- **Ciclo:** 3

## Contexto

El punto 7 del [ADR 0016](0016-folios-por-dispositivo-y-hora-corregida.md) dice que la hora efectiva de una operación es la del dispositivo más la
diferencia medida con el servidor, **nunca posterior al momento en que el servidor se enteró**, y que si la corregida queda después de la
recepción se recorta a ella y se marca `future`. El [ADR 0027](0027-registro-de-ventas-y-atencion.md) (punto 11) pone `future` entre las marcas
que piden atención: la venta sale en la bandeja «Requiere atención».

La regla no tiene ninguna tolerancia: `future` se marca si la hora corregida pasa de la recepción **por un milisegundo**.

La prueba de Samuel en un Android real (C3-16, 25 de octubre de 2026) la puso a prueba: una venta con vuelto, cobrada con red y enviada al
instante, quedó en «Requiere atención» con «La hora del equipo estaba en el futuro: se corrigió la hora de la venta». No se anotó la diferencia
del reloj de ese teléfono, así que no se sabe si el reloj estaba adelantado. Lo que sí se sabe es lo que dice el propio ADR 0016: la diferencia
se mide **a mitad del viaje** de ida y vuelta, y se acepta un viaje de hasta 5 s, así que **la medición se equivoca hasta 2,5 s**. Una venta
mandada 1 o 2 segundos después de hacerla puede quedar por delante de la recepción solo por ese error, sin que el reloj esté mal. Pasaría con
cada venta cobrada con red en un teléfono con datos móviles o con la API despertando, y el dueño vería una alarma en ventas que salieron bien.

## Decisión

1. **`future` se marca solo si la hora corregida pasa de la recepción por más de `FUTURE_TOLERANCE_MS`**, que vale **2 500 ms**: la mitad del
   viaje más largo que todavía se acepta para medir el reloj (`MAX_ROUND_TRIP_MS / 2`). Es el error que el ADR 0016 ya reconoce de la medición,
   no un número nuevo.

2. **Dentro de la tolerancia la hora se recorta igual.** La hora efectiva sigue siendo la de la recepción (`source` = `received`) y nunca
   posterior a ella; lo único que cambia es que no se agrega la marca.

3. **Pasada la tolerancia todo sigue como estaba:** la hora se recorta a la recepción y la operación se marca `future`. Un reloj adelantado
   unos segundos con la diferencia medida se corrige solo; uno adelantado de verdad (minutos, horas) sigue marcándose, además de `clock-skew`
   cuando pasa de 5 minutos.

4. **No cambia nada más del ADR 0016:** el resto de las marcas (`clock-skew`, `clock-unverified`, `stale`, `unreadable`), el recorte y que
   el servidor **nunca rechaza** una operación por su hora.

## Alternativas consideradas

### Dejar la regla como está

Cada venta cobrada con red en un teléfono con un viaje lento puede aparecer como «Requiere atención» sin que haya nada que revisar. Una bandeja
que se llena de falsas alarmas se deja de mirar, y entonces una venta que sí necesita atención pasa sin que nadie la vea.

### Quitar `future` de las marcas que piden atención

Arregla la falsa alarma, pero también esconde un reloj adelantado de verdad (horas), que es lo que la marca existe para encontrar. El ADR 0016
dice que `future` o `stale` son lo único que delata a quien cambia el reloj a mano.

### Una tolerancia más grande (5 s, 30 s, 1 minuto)

Cubriría más casos de viajes lentos, pero el número no sale de nada medido: dejaría pasar relojes adelantados de verdad hasta ese punto. 2,5 s es
lo que el ADR 0016 reconoce como error de la medición.

### Una tolerancia que dependa del viaje medido

Más exacta (el error real es la mitad del viaje de esa medición), pero el viaje de la última medición no viaja con la operación: habría que
agregar un campo al contrato por una marca que solo informa. Se puede hacer más adelante si 2,5 s resulta corto.

## Consecuencias

### A favor

- **Una venta cobrada con red deja de aparecer en «Requiere atención» por el error de la medición.** La bandeja vuelve a significar «alguien
  tiene que mirar esto».
- **Es el error que el ADR 0016 ya reconocía,** así que la tolerancia no agrega un número arbitrario y la prueba la compara con
  `MAX_ROUND_TRIP_MS`.
- **Compatible:** no cambia el contrato, ni el esquema, ni lo que ya está guardado.

### En contra

- **Un reloj adelantado 2 s o menos sin diferencia medida ya no se marca `future`.** Sigue marcado `clock-unverified`, y se corrige la hora
  de la venta al recortarla, pero ya no pide atención. Es un desvío chico que no cambia el día del reporte ni el turno de nadie.
- **La tolerancia es el error máximo, no el típico:** la simulación del ADR 0016 daba un error máximo de la hora corregida de 1,5 s con
  viajes de 20 a 900 ms. Con viajes lentos de verdad (cerca de 5 s) el error llega a 2,5 s y una venta enviada al instante todavía podría
  quedar justo en el borde.
- **Las ventas ya guardadas con `future` no cambian:** la marca se calculó cuando llegaron. Las de PRE son de prueba; con datos reales habría
  que decidir si se recalculan.
- **No se confirmó que esa fuera la causa del caso de Samuel.** Falta la diferencia del reloj de ese teléfono contra una hora de referencia
  (`https://time.is`). Si el reloj estaba adelantado de verdad, la marca era correcta y este ADR no la cambia más allá de los 2,5 s.
