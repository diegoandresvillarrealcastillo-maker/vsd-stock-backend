# ADR 0030 — La aplicación instalable, el motor de envío y una pantalla que dice la verdad

- **Estado:** Aceptada
- **Fecha:** 2026-10-20
- **Ciclo:** 3

## Contexto

El [ADR 0009](0009-motor-offline-y-libro-de-movimientos.md) decidió que lo que se hace sin conexión espera en una cola y se envía
cuando hay conexión, el [ADR 0017](0017-roles-permisos-y-modo-sin-conexion.md) qué se puede hacer sin ella, el
[ADR 0028](0028-lote-de-sincronizacion-y-copia-de-lectura.md) cómo es el lote que recibe el servidor y la copia de lectura que se baja,
y el [ADR 0029](0029-almacenamiento-local-de-cada-persona-y-mostrador-sin-conexion.md) dónde y cómo se guarda todo. Falta decidir
**el lado del dispositivo**: cómo se instala y abre una aplicación web sin internet, cuándo y cómo se envía la cola (cuándo se
reintenta, a qué ritmo, qué pasa con dos pestañas), cuándo se baja la copia, y sobre todo **qué le dice la pantalla a la persona**: un
indicador que afirma «guardado» o «en línea» sin saberlo es peor que ninguno.

También hay que decidir cómo se **prueba** esto en un navegador de verdad: una cola, un candado entre pestañas y un service worker
no se verifican con un doble de IndexedDB.

## Decisión

### La aplicación se instala y abre sin internet

1. **Un service worker guarda la interfaz** (página, JavaScript, estilos, iconos) **una sola vez**, al instalarse una versión, y la
   sirve desde la caché. **Nunca guarda datos:** no sabe escribir en la caché después de instalarse y no atiende lo que no es de la
   interfaz: ni un `POST`, ni otro origen, ni ninguna ruta `/v1/` de la API. Los datos viven en la base cifrada (ADR 0029), con dueño
   y con olvido, no en una caché compartida.
2. **Una versión nueva nunca se activa sola.** Se instala en segundo plano y espera; la aplicación dice «Hay una versión nueva de VSD
   Stock» con **Actualizar ahora** y **Más tarde**. Actualizar recarga la página, así que la pantalla de venta puede pedir esperar
   (`useHoldUpdates`) y el aviso solo dice «Termina la venta en curso para actualizar». Si un archivo falla al instalarse, esa versión
   no se instala (todo o nada) y la anterior sigue sirviendo.
3. **Manifiesto e iconos** (192, 512 y uno enmascarable) para instalarla; el color de la barra del navegador sigue el tema. En el
   servidor de desarrollo **no** se instala el service worker: una interfaz guardada taparía los cambios.
4. **Presupuesto de peso, vigilado por el CI:** JavaScript 180 KB, estilos 12 KB y service worker 3 KB, comprimidos (gzip nivel 9). Rompe
   el CI si algo se pasa, para que el peso se discuta cuando se rompe y no cuando ya no se puede arreglar.

### El motor de envío

5. **Se envía cuando el servidor confirma que hay conexión** (`GET /health`, no lo que el navegador cree de la red), cuando se agrega
   una operación a la cola, cuando entra una persona y cuando vence una espera. La persona también puede pedirlo («Reintentar ahora»).
6. **De a un lote, la operación más antigua primero:** hasta **20 operaciones o 64 KB** de cuerpos, lo que llegue antes. El servidor
   acepta hasta 50 (ADR 0028); el dispositivo manda menos porque un teléfono con mala red pierde menos si un envío se cae a la mitad.
   Una operación sola siempre sale, pese lo que pese.
7. **Una pestaña a la vez**, con un candado del navegador (Web Locks, nombre `vsd-stock-sync`) pedido con `ifAvailable`: la pestaña que
   llega cuando otra ya está enviando **no espera ni envía**; solo mira la cola. En un navegador sin Web Locks el candado funciona dentro
   de la página (una vez a la vez), y el servidor resuelve el resto con la idempotencia por `operationId` (ADR 0019).
8. **Cada resultado se clasifica como cualquier respuesta** (ADR 0009, punto 6; ADR 0019, punto 5):

   | El servidor dice                                     | Qué hace el dispositivo                                                                         |
   | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
   | `2xx` (incluido el `200` de una operación repetida)  | **Sale de la cola:** el servidor la tiene                                                       |
   | `408`, `425`, `429`, `5xx`, o algo que no es 4xx/5xx | **Se queda**, cuenta un intento y se reintenta con espera                                       |
   | `409` u otro `4xx`                                   | **Se aparta y pide atención:** enviarla otra vez no cambia la respuesta; no bloquea a las demás |
   | `401`                                                | **Es de la sesión, no de la operación:** se detiene todo, se avisa y la cola se conserva        |
   - **Sin respuesta de red no se gasta un intento:** la vigilancia de conexión comprueba y avisa cuando vuelva.
   - **Una petición que el servidor rechaza entera** (muy grande, mal formada) cuenta un intento en cada operación del lote y **dice por
     qué**; no hay a quién culpar y reintentar igual no la arregla, pero tampoco se abandona.
   - **Una respuesta que no tiene la forma del contrato** (un proxy, otra versión del servidor) es un fallo que puede pasar, **nunca un
     éxito**: aceptarla como buena sacaría de la cola operaciones que el servidor no recibió.

9. **La espera tras un fallo** es de 2 segundos que se duplican hasta **5 minutos**, con azar de la mitad a la totalidad (para que muchos
   dispositivos que vuelven a la vez no lleguen juntos) y **nunca menos de lo que pida `Retry-After`**.
10. **El reloj del dispositivo se mide con la hora que da el servidor** en cada lote (la hora del servidor menos la mitad del viaje, ADR
    0016). No se fía de la medición si el viaje tardó **más de 5 segundos** o si el reloj se movió mientras se esperaba, y conserva la
    última buena.

### La copia de lectura

11. **Se baja** cuando el servidor confirma que hay conexión, cuando empieza a trabajar alguien, cuando el dispositivo acaba de enviar
    algo (la existencia se movió) y cuando la persona toca «Actualizar». **No hay un reloj que la repita sola.** Una descarga a la vez.
12. **De a 200 por página** (el máximo del servidor) y **solo lo que cambió**: la primera vez, todo; después, lo que cambió desde **un
    minuto antes** de la hora del servidor de la **primera página** de la descarga anterior (ADR 0028, punto 11). La hora de una descarga
    **solo se mueve cuando termina completa**: si falla a la mitad, lo que llegó se guarda y se vuelve a pedir desde el mismo punto.
13. **Un fallo no borra lo que ya había.** Se dice por qué (sin conexión, sesión caducada u otro) y se sigue con esa copia: es lo que
    permite vender. **Nunca mezcla personas:** lo que está en memoria es de quien trabaja, y una descarga que llega cuando la persona
    ya cambió no toca nada.
14. **La búsqueda es local y no espera a nadie:** en cualquier orden de palabras, sin importar mayúsculas ni tildes, por el nombre, el
    código del negocio o el código de barras (completo, con o sin el cero que vuelve un UPC en EAN). Un código exacto va primero; no
    ofrece archivados.

### Lo que la pantalla dice

15. **El estado del envío aparece en todas las páginas**, como una región `status` (un lector de pantalla anuncia cada cambio). Cuando
    todo está en orden ocupa **una línea**; cuando algo pide atención, una tarjeta con lo que se puede hacer ahí mismo. El texto lo
    decide una función pura, en este orden, del que más importa al que menos:

    | Situación                              | Dice                                                                              |
    | -------------------------------------- | --------------------------------------------------------------------------------- |
    | La sesión caducó                       | **Tu sesión caducó** + «Entrar de nuevo»                                          |
    | El servidor no aceptó N operaciones    | **N requieren atención**                                                          |
    | Se está enviando                       | **Enviando…**                                                                     |
    | Hay algo por enviar y no hay conexión  | **Sin conexión**, con cuántas esperan y que «están guardadas solo en este equipo» |
    | Hay algo por enviar y aún se comprueba | **Comprobando conexión…**                                                         |
    | El último envío falló                  | **No se pudo enviar** + «Reintentar ahora»                                        |
    | Hay algo por enviar y hay conexión     | **Por enviar**                                                                    |
    | Nada espera y el servidor aceptó algo  | **Todo enviado**, y cuándo                                                        |
    | Nada espera y nunca se envió nada      | **Nada por enviar**                                                               |

16. **Reglas que no se negocian:** nunca dice «en línea» mientras solo **comprueba**, ni «todo enviado» si hay algo guardado solo en el
    equipo. **«Entrar de nuevo» es «Cambiar de persona»:** cierra la sesión y **conserva la cola** (ADR 0029). El color acompaña, nunca es
    lo único: cada tono tiene su icono y su texto.
17. **Lo que viene de la copia dice de cuándo es** («Catálogo al 19 oct, 3:30 p. m.», «Existencias al…»): nadie debe leer esa cifra como
    la existencia de hoy en todas las cajas (ADR 0028, punto 12).

### Pruebas en un navegador de verdad

18. **Playwright, contra la API y la base reales** (C3-15): la red cortada de verdad, recargar a mitad de una venta, dos pestañas, la
    cola que sobrevive a cerrar el navegador. **Chromium bloquea el CI** (es el navegador del teléfono Android que usa el negocio de
    referencia); **Firefox y WebKit se corren y se informan, pero no bloquean** hasta que el dueño del repositorio decida lo contrario,
    porque sus diferencias de IndexedDB y de Web Locks son justo lo que hay que conocer antes de prometer algo en esos equipos.
19. **N dispositivos virtuales con el motor real** repiten la simulación del ADR 0016 por HTTP y con el lote: varios dispositivos venden
    en orden aleatorio, se desconectan a mitad de un lote y reenvían; cero folios repetidos, cero ventas duplicadas y el saldo cuadra
    con el libro.
20. **Accesibilidad con axe en cada pantalla** y, como hasta ahora, Lighthouse en el CI (accesibilidad 100).

## Alternativas consideradas

- **Una biblioteca de service workers (Workbox):** otra dependencia y más peso para guardar seis archivos de la interfaz. El service
  worker propio pesa 1,7 KB y es el mismo archivo que prueba la suite.
- **Que el service worker guarde también las respuestas de la API (caché de datos):** una caché compartida no tiene dueño ni olvido, y
  un dato viejo serviría como si fuera de hoy. Los datos viven en la base cifrada de quien trabaja.
- **Activar la versión nueva en cuanto llega:** recargaría la página a mitad de una venta. Se espera a que la persona lo decida.
- **Background Sync del navegador** para enviar con la aplicación cerrada: no existe en Safari ni Firefox, así que no se puede prometer;
  y un envío fuera de la aplicación no puede decir nada. Una operación pendiente se envía la próxima vez que alguien abre la aplicación.
- **Elegir una pestaña «líder» con un canal de mensajes:** hay que resolver quién muere y quién lo nota. Con Web Locks, el navegador
  decide y suelta el candado si la pestaña muere.
- **Confiar en `navigator.onLine`:** dice que hay red, no que el servidor responde (una red sin salida, un portal cautivo).
- **Reintentar a intervalo fijo:** muchos dispositivos que vuelven a la vez llegarían juntos cada vez. La espera crece y se reparte.
- **Una sola operación por petición:** multiplica los viajes justo cuando la conexión es mala.
- **Mandar los 50 que acepta el servidor:** un envío que se cae a la mitad con 50 duele más que con 20.
- **Un indicador que solo diga «sincronizado» o «sin conexión»:** esconde lo que importa: cuántas ventas esperan, cuáles el servidor no
  aceptó y que la sesión caducó con ventas guardadas.
- **Cypress, o solo Chromium sin informar de los otros:** Playwright corre los tres motores con la misma API y soporta cortar la red
  del contexto; si Firefox o WebKit se rompen, hay que saberlo aunque no bloqueen.

## Consecuencias

### A favor

- **La aplicación abre sin internet** con la interfaz de la última versión instalada, y una versión nueva nunca interrumpe una venta.
- **Una conexión corta vacía una cola larga** en pocos viajes, sin duplicar nada, y dos pestañas nunca envían a la vez.
- **El dispositivo nunca da por enviado lo que el servidor no tiene**, ni por cierto lo que no sabe.
- **Lo que no pudo enviarse se ve, se cuenta y se puede reintentar**; lo que el servidor rechazó se aparta sin frenar a las demás.
- **Se puede vender con lo bajado** aunque la descarga siguiente falle, y la búsqueda no espera a nadie.

### En contra

- **Una operación pendiente se queda en el equipo hasta que alguien abra la aplicación:** sin Background Sync, un teléfono apagado con
  ventas sin enviar no las manda solo. Por eso se muestra siempre cuántas hay.
- **Un error que nadie previó en la cola** sube a quien lo pidió (`syncNow` lo rechaza), pero lo que arranca solo lo deja como error
  sin manejar del navegador; no pierde operaciones, y queda anotado.
- **La copia no se actualiza sola cada cierto tiempo:** si alguien deja el mostrador abierto un día sin enviar nada ni perder la
  conexión, el catálogo no cambia hasta que se toque «Actualizar» o se envíe algo.
- **Los 20 por lote, los 2 segundos, los 5 minutos y los 5 segundos del reloj son decisiones, no mediciones:** se ajustan con el
  teléfono real (C3-16).
- **Una versión del service worker que falla a medio instalar no se instala, pero no avisa.**
- **El presupuesto de 180 KB de JavaScript** deja poco margen para la pantalla de venta; si no alcanza, la salida escrita es separar
  por rutas las pantallas de administración.
- **Tres navegadores triplican el tiempo del CI** y dos de ellos no bloquean: se corre en paralelo y se acepta que un rojo de Firefox o
  WebKit sea una noticia y no un freno.
- **Nada de esto está verificado en un teléfono.** Es C3-16, con las mediciones que faltan (el toque en menos de 100 ms, 60 cuadros por
  segundo, cuántas veces pide la contraseña, la deriva del reloj).
