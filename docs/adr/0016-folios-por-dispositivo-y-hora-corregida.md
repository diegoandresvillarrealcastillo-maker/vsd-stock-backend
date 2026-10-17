# ADR 0016 — Folios por dispositivo y hora corregida con el servidor

- **Estado:** Aceptada
- **Fecha:** 2026-10-17
- **Ciclo:** 1

## Contexto

Dos preguntas del [mapa de contextos](../dominio/mapa-de-contextos.md) quedaron abiertas por el motor sin
conexión del [ADR 0009](0009-motor-offline-y-libro-de-movimientos.md):

- **¿Cómo se numeran los folios para que dos cajas sin conexión no choquen, y qué ve la persona mientras tanto?**
  Un cajero entrega un número al cliente en el momento de la venta, sin red. Si ese número cambia al sincronizar,
  el cliente y el negocio hablan de ventas distintas.
- **¿Qué hora vale en una operación sin conexión?** El único reloj que existe al vender es el del dispositivo, y el
  de un teléfono barato puede estar horas desajustado. De la hora dependen el turno de caja, el día del reporte y
  la auditoría.

Ambas se pueden demostrar sin esquema real: la simulación
[`test/simulation/offline-devices.spec.ts`](../../test/simulation/offline-devices.spec.ts) pone a 50 dispositivos a
vender a la vez con relojes desajustados, y
[`folios.integration.spec.ts`](../../test/integration/folios.integration.spec.ts) prueba el lado del servidor
contra PostgreSQL real.

## Decisión

1. **El folio es `{código del dispositivo}-{serie}`**, por ejemplo `AA-000142`, y la persona lo ve en el momento de
   vender. **No hay folio provisional:** no cambia al sincronizar. Lo que sí se muestra aparte es si la venta ya
   se envió.
2. **El código del dispositivo lo asigna el servidor** al registrar el dispositivo, que exige conexión y ocurre al
   iniciar sesión por primera vez en él. Sale de **un contador por negocio**, no del azar: de 2 caracteres
   (`AA`, `AB`... hasta 900 dispositivos), después de 3 y de 4, de un alfabeto de 30 caracteres **sin 0, 1, I, L, O ni
   U**, que se confunden al leerlos o dictarlos. **Nunca se reutiliza:** si se borran los datos de un dispositivo o
   se reinstala la aplicación, se registra de nuevo y recibe un código nuevo.
3. **La serie es un entero que solo crece, por dispositivo.** La aplicación la incrementa **en la misma
   transacción de IndexedDB que guarda la operación**, y bajo el candado de Web Locks si hay varias pestañas, de
   modo que ni dos ventas del mismo dispositivo ni dos pestañas repiten un número. Puede haber saltos; una venta
   anulada conserva su folio.
4. **El folio identifica, no ordena.** No dice cuál de dos ventas de dispositivos distintos fue primero; para eso
   está la hora.
5. **El servidor lo vigila igual**, con `UNIQUE (id_negocio, folio)`. Si llega una venta cuyo folio ya es de otra
   operación (un dispositivo clonado, un disco copiado), **se acepta** con el folio `AA-000142~<8 primeros del
operationId>`, marcada como conflicto y conservando el folio que trajo. Se avisa al dueño o al administrador
   (ADR 0009). Una venta que ya ocurrió en el mostrador nunca se rechaza.
6. **Cada operación trae la hora del reloj del dispositivo y su última diferencia medida con el servidor.** El
   dispositivo mide esa diferencia en cada `GET /health` que responde, como en NTP: se supone que el servidor
   contestó a la mitad del viaje, `diferencia = horaDelServidor − (salida + llegada) / 2`. Si el viaje duró más de
   5 s la medición no sirve y no se actualiza.
7. **El servidor guarda tres horas:** la cruda del dispositivo, la **efectiva** y el momento en que se enteró. La
   efectiva es la cruda más la diferencia, **nunca posterior al momento en que el servidor se enteró**, y si no se
   puede leer vale ese momento. Nunca rechaza. Marca lo raro para que alguien lo mire:

   | Marca              | Cuándo                                                             |
   | ------------------ | ------------------------------------------------------------------ |
   | `clock-skew`       | El reloj se desvía más de 5 minutos: hay que arreglarlo            |
   | `clock-unverified` | Nunca se midió la diferencia: se confió en el reloj tal cual       |
   | `future`           | La hora corregida quedó después de la recepción: se recortó a ella |
   | `stale`            | La operación esperó más de 72 horas en el dispositivo              |
   | `unreadable`       | La hora no es una fecha ISO 8601 en UTC con `Z`: vale la recepción |

8. **El día del negocio es el de Colombia** (`America/Bogota`, UTC−5 y sin horario de verano) calculado desde la
   hora efectiva: una venta a las 22:30 en Bogotá es de ese día aunque ya sea «mañana» en UTC. Los instantes se
   guardan en UTC (`timestamptz`) y solo se pasan a día al leer.

### Lo que se midió

La simulación (determinista; las cifras son las de la semilla 11): 50 dispositivos, 12 000 pasos, **9 587 ventas**, relojes desajustados
hasta ±6 horas, deriva de hasta 20 ppm, viajes de 20 a 900 ms con el servidor contestando entre el 30 % y el 70 %
del viaje, y dispositivos que se borran y se reinstalan en el camino.

- **Cero folios repetidos** en seis semillas distintas.
- De las ventas con el reloj medido (8 948), **el error máximo de la hora corregida fue de 1,5 s**.
- 639 ventas, de dispositivos que aún no habían medido su reloj, quedaron marcadas `clock-unverified`.
- Como control, los mismos escenarios **sí repiten folios** si un dispositivo borrado conserva su código, o si el
  folio fueran seis dígitos al azar (diez mil ventas dan decenas de repeticiones: la paradoja del cumpleaños).

### Lo que NO se decide aquí

- **Cómo se ve la marca** de hora en la interfaz y qué hace el dueño con ella (Ciclo 3).
- **Los folios de otras cosas**: turnos, compras y ajustes se identifican por su `operationId`.
- **Una zona horaria distinta de Colombia.** Es una constante, no una configuración.
- **Quien cambia el reloj del equipo a mano** entre la medición y la venta no se detecta; solo lo delatan `future`
  o `stale` cuando el cambio es grande.

## Alternativas consideradas

### Que el servidor asigne el folio al sincronizar

Es la numeración más limpia (una serie del negocio), pero sin red no hay número: habría que dar un folio
provisional y cambiarlo después, y el ticket que la persona ya entregó quedaría con un número que no existe.

### Un identificador aleatorio corto

Sin coordinación, pero con colisiones inevitables: diez mil ventas en un espacio de un millón de números dan
decenas de repeticiones (lo demuestra la simulación). Uno lo bastante largo para no colisionar no se puede dictar.

### Bloques de números reservados por dispositivo

El servidor entrega «tienes del 1000 al 1999» y no hay colisión posible. Pero necesita conexión para renovar el
bloque, deja la venta sin número si se agota sin red y añade estado que sincronizar. Podría retomarse si hiciera
falta una serie continua.

### Un código de dispositivo derivado del equipo o elegido por la persona

Un identificador de hardware no es único ni estable en un navegador; y uno elegido a mano se repite. El contador
del servidor es lo único que garantiza la unicidad.

### Confiar en el reloj del dispositivo

Un reloj atrasado cuatro horas pasa las ventas de la noche al día siguiente, y con ellas la caja y los reportes.

### Usar siempre el momento en que el servidor se enteró

Una venta del sábado sincronizada el lunes caería en lunes: el turno de caja del sábado no cuadraría.

### Rechazar la operación con una hora imposible

Contradice el principio del ADR 0009: la mercancía ya salió del mostrador.

## Consecuencias

### A favor

- **No hay colisiones por construcción:** dos dispositivos tienen códigos distintos y uno solo no repite su serie.
- El número que ve el cliente **no cambia nunca**.
- La hora guardada queda a segundos de la verdad aunque el reloj del equipo esté horas desajustado, y la hora
  cruda **se conserva**, así que corregir no pierde información.
- Nada se rechaza: lo raro se marca y se atiende.

### En contra

- **Un dispositivo debe registrarse con conexión antes de poder vender sin ella.** Es coherente con que iniciar
  sesión también la exige, pero un equipo sin registrar no sirve en un apagón.
- **Un dispositivo clonado** (una copia del disco) repite folios hasta que alguien lo note; el servidor lo acepta
  y lo marca, pero el cliente ya recibió dos tickets con el mismo número.
- **Cada reinstalación gasta un código.** Son 837 900 por negocio, y gastarlos es improbable, no imposible.
- **Los folios tienen saltos y no ordenan.** Un reporte en orden cronológico usa la hora, no el folio.
- **La hora corregida depende de una medición.** Un dispositivo que no la hizo queda marcado y sin cota. La deriva
  del reloj (20 ppm en la simulación, **un supuesto sin medir en teléfonos baratos**) se ignora entre mediciones.
- **72 horas, 5 minutos y 5 segundos son valores razonables, no medidos.** Se ajustan con datos reales.
- **La zona horaria es una constante.** Un negocio fuera de Colombia exige otro ADR.
- Nada de esto está probado **en un navegador** ni con IndexedDB: el incremento atómico de la serie es una regla
  para el motor del Ciclo 3, que debe probarla con el almacenamiento real.

### Mitigación acordada

- La simulación corre en cada PR y falla si algún cambio hace repetir un folio.
- El Ciclo 3 copia `estimateClockOffset` al frontend con sus pruebas y repite la simulación contra el motor real.
- El ADR 0018 (olvido del dispositivo) debe decir que olvidar un dispositivo borra también su serie y exige un
  registro nuevo, para que nunca se reinicie bajo el mismo código.
