# ADR 0029 — Almacenamiento local de cada persona: una base cifrada, un mostrador que se reanuda y dos formas de irse

- **Estado:** Aceptada
- **Fecha:** 2026-10-20
- **Ciclo:** 3

## Contexto

El [ADR 0018](0018-cifrado-local-y-olvido-del-dispositivo.md) decidió **qué** se cifra y **cuándo** se olvida, y el
[ADR 0022](0022-identidad-y-sesion.md) que el token no se guarda y que la sesión sin conexión dura 72 horas desde la última
verificación del servidor. Faltaba lo que ocurre al construirlo: cómo se organiza lo guardado de cada persona en el navegador,
cómo vuelve una persona al mostrador sin conexión, qué pasa cuando dos personas comparten el equipo y qué se hace cuando algo
sale mal (sin IndexedDB, una clave que desapareció, otra pestaña que no suelta la base).

Lo que se guarda, además, creció con el ciclo: el perfil de quien trabaja, el registro del dispositivo y su serie de folios
(C3-08), la **cola de operaciones sin enviar** (C3-09) y la **copia de lectura** del catálogo y de la existencia (C3-10). Todo
va a la misma base, y las mismas reglas de cifrado y de olvido valen para todo.

## Decisión

### Una base por persona

1. **Una base de IndexedDB por persona**, llamada `vsd-stock-<identificador de la persona en el servicio de identidad>`, nunca su
   nombre ni su correo: los nombres de las bases se pueden listar (ADR 0018, punto 5). Tiene tres almacenes:
   - `meta`: la **clave** y el **contador de la serie de folios** (un número). No lleva datos personales.
   - `records`: registros **cifrados** con el nombre como clave: el perfil (`profile`), el dispositivo (`device`), cada producto de
     la copia (`product:<id>`), cada existencia (`stock:<id>`) y lo que se sabe de las descargas (`copy-checkpoint`).
   - `operations`: la cola de operaciones sin enviar. Lo que se busca va **en claro** (identificador, estado y hora); el contenido,
     cifrado.
2. **El cifrado es el del ADR 0018:** AES-GCM de 256 bits, un vector de 96 bits por registro, el **nombre del registro como dato
   autenticado** y una clave `CryptoKey` **no extraíble** guardada en `meta` de la misma base. Un registro alterado o copiado al lugar
   de otro **no se abre**, y se lee como «no hay nada»; nunca se devuelven datos dañados. Los nombres de los registros llevan solo
   identificadores: el nombre de un producto, un código o un precio van **dentro** del cifrado.
3. **Lo que no se puede abrir no se da, pero cuenta:** una operación ilegible se salta al armar el lote y **sigue contada como
   pendiente** (no se envía, y el indicador no miente sobre que hay algo guardado); un producto o una existencia ilegibles simplemente
   no aparecen y se bajan de nuevo en la próxima descarga completa.

### Lo que se guarda y cómo se escribe

4. **El folio** (`AA-000142`): la serie se reserva en una **transacción propia** de IndexedDB, antes de cifrar o guardar nada más.
   Dos pestañas **nunca reciben el mismo número**; si lo que se iba a hacer con el número falla, queda un salto, que no importa
   (ADR 0016).
5. **El registro del dispositivo** guarda su identificador **antes** de pedir el código al servidor. Si la respuesta se pierde, se
   repite con el mismo identificador y el servidor devuelve el mismo dispositivo. Quién gana cuando dos pestañas lo intentan a la vez
   lo decide el almacenamiento (`claimDevice`): todas terminan con el mismo.
6. **La cola** guarda cada operación con el **cuerpo exacto de su ruta individual** (ADR 0028), su identificador, la hora en que se
   hizo y sus intentos. Escribir una que ya está **no la pisa**; cambiar una (un intento más, apartarla para atención) se hace sobre
   lo que hay **ahora** y **no resucita** lo que otra pestaña ya sacó de la cola.
7. **La copia de lectura** guarda un registro por producto y uno por existencia. Al guardar un producto que ya estaba **gana el de
   `updatedAt` mayor** (aplicar dos veces el mismo no hace daño, ADR 0028), la existencia se **reemplaza** por la de ahora, y la hora
   de la **primera página** de cada descarga completa queda asentada para pedir lo siguiente.

### Entrar, volver y sobrevivir sin conexión

8. **Entrar con conexión** abre la base de la persona (la crea la primera vez), anota que **el servidor la confirmó ahora** y registra
   el dispositivo si todavía no lo está. Quién trabajó por última vez se recuerda con **un identificador** en `localStorage`
   (`vsd-stock-person`): solo un UUID, nada personal.
9. **Sin conexión, el mostrador se reanuda hasta 72 horas después** de la última confirmación del servidor (ADR 0022): la pantalla
   de entrar ofrece «Continuar sin conexión». Pasado el plazo **se bloquea, pero la base se conserva**: se desbloquea entrando con la
   contraseña y conexión. Dos reglas lo cuidan:
   - **Un reloj atrasado no estira el plazo:** si la hora del equipo está más de **5 minutos** por detrás de la última confirmación,
     el mostrador se bloquea (`clock-behind`).
   - **Reanudar no renueva nada:** solo el servidor puede confirmar a una persona.
10. **Recargar la página con conexión pide la contraseña** (el token no se guarda, ADR 0022), con el correo de la persona ya escrito.

### Dos formas de irse

11. **«Cambiar de persona» conserva todo lo guardado.** Cierra la sesión y suelta la base: las ventas sin enviar de quien se va siguen
    ahí y se enviarán cuando vuelva a entrar. Es también lo que hace «Entrar de nuevo» cuando la sesión caducó con ventas pendientes.
12. **«Cerrar sesión» olvida.** Borra la base de la persona en un solo paso (`deleteDatabase`, que se lleva la clave). Si hay
    operaciones sin enviar, **antes dice cuántas son y pide confirmación**, porque confirmar las pierde. **Si no se pudo contar** lo que
    espera, o **si otra pestaña no suelta la base**, no se borra nada ni se sale: se dice por qué («cierra las otras pestañas de
    VSD Stock e inténtalo de nuevo»). Una sesión que **caduca** no borra: la base se suelta y se conserva.

### Cuando el navegador no puede, o algo se perdió

13. **Sin IndexedDB, sin HTTPS o en una ventana privada** (no hay dónde guardar cifrado), la aplicación **lo dice** y sigue
    funcionando **con conexión**; solo el mostrador sin conexión no está disponible.
14. **Si la clave desapareció y quedan operaciones sin enviar** (el navegador borró la clave y dejó los datos), abrir la base con una
    clave nueva las dejaría perdidas sin que nadie lo sepa: la base **no se abre** y se avisa **cuántas son**. La persona decide
    empezar de nuevo con la base vacía; confirmar las pierde.
15. **Se pide almacenamiento persistente** (`navigator.storage.persist()`, ADR 0018 punto 9) al abrir la aplicación, y la pantalla
    dice lo que respondió el navegador: protegido, «podría borrar lo guardado: envía tus ventas pronto» o «este navegador no puede
    protegerlo».

## Alternativas consideradas

- **`localStorage` para todo:** síncrono, de 5 MB, sin transacciones y sin índices. La serie de folios necesita una transacción que
  impida repeticiones entre pestañas, y una cola de ventas puede pesar más de 5 MB.
- **Una sola base para todas las personas del equipo:** cambiar de persona obligaría a abrir y filtrar una base ajena, y olvidar a
  una se llevaría a las demás. Una base por persona hace que olvidar sea un solo paso y que lo de otra persona sea ilegible con
  **otra clave**.
- **Guardar el catálogo sin cifrar «porque no es un dato personal»:** el catálogo, los precios y las existencias de un negocio son
  datos del negocio, y el costo de cifrarlos es de décimas de milisegundo. Una sola regla para todo es más fácil de vigilar que una
  lista de excepciones.
- **Cifrar con una clave que viene del servidor y vive solo en memoria:** protegería de un perfil copiado, pero sin conexión, tras
  cerrar el navegador, no habría clave (ADR 0018).
- **Una base de SQL cifrada en WebAssembly:** más peso, otra dependencia y otra arquitectura, para cifrar también los índices; con
  la regla de que los índices no llevan datos personales alcanza.
- **Borrar la base cuando la sesión caduca:** perdería ventas que nadie ha enviado, justo cuando la persona está sin conexión o con
  la sesión vencida.
- **Renovar el plazo de 72 horas al reanudar sin conexión:** cualquiera podría estirarlo indefinidamente; solo el servidor confirma.
- **Guardar la copia de lectura en la caché del service worker:** esa caché es solo de la interfaz (ADR 0030); los datos viven en una
  base cifrada, con dueño y con olvido.

## Consecuencias

### A favor

- **Olvidar a alguien es un solo paso y completo**, y quien comparte el equipo no ve ni puede abrir lo de otra persona.
- **Lo guardado no puede alterarse en silencio:** un bit cambiado o un registro movido se detecta en vez de producir datos dañados.
- **La serie de folios no repite jamás**, ni entre pestañas ni tras un fallo.
- **Una persona vuelve al mostrador sin conexión** hasta tres días después, sin que un reloj mal puesto alargue el plazo.
- **Nada se pierde sin avisar:** la clave perdida, el almacenamiento protegido, lo que espera y lo que no se pudo abrir se dicen.

### En contra

- **La protección es la del ADR 0018 y no más:** no cubre un script dentro de la página, ni el perfil copiado completo, ni el equipo
  de quien lo controla. La clave vive junto a los datos.
- **Perder la clave pierde los datos.** Con operaciones sin enviar son ventas perdidas; por eso se muestra siempre cuántas hay y se
  avisa antes de cerrar sesión.
- **Abrir una base grande cuesta:** con 0,16 ms por registro al leer y descifrar (ADR 0018), un catálogo de 5 000 productos tarda
  alrededor de 0,8 s en ponerse en memoria al empezar a trabajar. No bloquea el hilo principal (la criptografía es asíncrona), pero
  se nota si el negocio tiene muchos más.
- **Una operación ilegible se queda ahí:** no se envía, sigue contando como pendiente y hoy no hay pantalla para verla ni para
  descartarla.
- **Otra pestaña puede impedir olvidar:** `deleteDatabase` espera a que todas suelten la base; se dice, pero la persona tiene que
  cerrarlas.
- **Los 72 horas y los 5 minutos son decisiones, no hechos medidos:** el reloj de un teléfono barato puede desviarse más; se mide en
  C3-16 y se ajusta.
- **Nada de esto está probado fuera de Chromium.** Firefox, Safari y, sobre todo, el Safari de iPhone y iPad (que limita el
  almacenamiento de las aplicaciones web que no se usan en varios días) se comprueban en C3-15 y C3-16 antes de prometer el modo sin
  conexión en esos equipos.
