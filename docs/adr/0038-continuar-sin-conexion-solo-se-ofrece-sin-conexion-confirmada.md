# ADR 0038 — «Continuar sin conexión» solo se ofrece mientras la conexión no esté confirmada

- **Estado:** Aceptada
- **Fecha:** 2026-10-25
- **Ciclo:** 3

## Contexto

El punto 11 del [ADR 0022](0022-identidad-y-sesion.md) y los puntos 9 y 10 del [ADR 0029](0029-almacenamiento-local-de-cada-persona-y-mostrador-sin-conexion.md)
dicen que **sin conexión** el mostrador se reanuda hasta 72 horas después de la última confirmación del servidor, y que **con conexión** recargar la
página pide la contraseña. El ADR 0029 (punto 9) añade que la pantalla de entrar «ofrece "Continuar sin conexión"»; no dice si eso vale también cuando
hay conexión, y la aplicación lo ofrecía siempre que la persona estuviera dentro del plazo.

La prueba de Samuel en un Android real (C3-16, 25 de octubre de 2026) lo encontró (frontend #109): el botón salía también con conexión. Y su otro
hallazgo (frontend #108) mostró lo que cuesta elegirlo teniendo red: quien continúa **no tiene sesión**, así que no ve la administración y nada se envía
hasta que escriba la contraseña, que es exactamente lo que habría hecho al principio. Es un camino peor que el que la pantalla tenía a un lado, ofrecido
justo cuando no hace falta.

La vigilancia de conexión (ADR 0030) distingue tres estados: `checking` (todavía sin respuesta), `online` (el servidor contestó `GET /health`) y
`offline` (no hay red o el servidor no contestó). El navegador solo decide cuándo preguntar; que diga que hay red no basta para estar en línea. La API
gratuita de PRE tarda cerca de un minuto en despertar (ADR 0031), y durante ese tiempo el estado es `checking`.

## Decisión

1. **La pantalla de entrar ofrece «Continuar sin conexión» solo mientras la conexión no esté confirmada:** en `checking` y en `offline`. Se oculta
   cuando el estado pasa a `online` y vuelve a aparecer si la conexión se pierde.

2. **Solo la respuesta del servidor la oculta.** Mientras se comprueba, el botón está: si la API duerme, quien abre el equipo en el mostrador no
   espera un minuto a que le dejen trabajar con lo que ya tiene guardado.

3. **Con la conexión confirmada la pantalla sigue diciendo quién trabajó última vez en este equipo,** con su correo ya escrito y que lo guardado se
   conserva; solo faltan el botón y la frase que lo anuncia. Pasado el plazo de 72 horas el aviso de que el mostrador está bloqueado no cambia.

4. **No cambia nada más del ADR 0022 ni del 0029:** las 72 horas, `clock-behind`, que reanudar no renueva nada, que la sesión vive solo en memoria y que
   sin sesión no se envía. Quien ya reanudó el mostrador y después recupera la conexión **no es sacado de ahí**: la tarjeta del estado le dice que falta
   la contraseña y su botón lo lleva a entrar sin borrar nada (#108).

5. **Es una regla de la interfaz, no de seguridad.** No hay endpoint nuevo ni se impide reanudar en el caso de uso: reanudar sigue sin dar ninguna
   credencial, y lo que hace la regla es no ofrecer el camino peor cuando el mejor funciona.

## Alternativas consideradas

### Dejarlo como está (ofrecerlo siempre)

Es lo que hacía la aplicación. Con red lleva a un mostrador sin sesión por elegir lo que no hacía falta, y la pantalla de entrar muestra dos caminos donde
uno solo es el bueno. Samuel lo vio y lo anotó como un defecto de la pantalla.

### Ocultarlo también mientras se comprueba

Evita que el botón aparezca y desaparezca. Pero con la API dormida la persona vería una pantalla sin salida durante cerca de un minuto, en el momento en
que más falta hace poder vender con lo guardado. El costo de que el botón parpadee es menor que el de una caja que no abre.

### Decidir por lo que dice el navegador (`navigator.onLine`)

Es inmediato, pero el navegador dice «hay red» con un portal cautivo, con datos móviles sin saldo o con la API caída. El ADR 0030 ya decidió que solo la
respuesta del servidor deja el estado en línea; esta regla usa la misma fuente.

### Impedir reanudar con conexión también en el caso de uso

Haría la regla más estricta, pero entre que el botón se oculta y alguien lo toca puede pasar un instante, y la regla no protege nada: reanudar no da
ninguna credencial ni renueva la última confirmación del servidor. Un fallo ahí dejaría a una persona sin entrar por una carrera de milisegundos.

### Reanudar solo, sin botón, al abrir sin red

Ahorraría un toque. Pero el equipo lo pueden compartir dos personas (ADR 0029): entrar solo como la última persona, sin que nadie lo elija, pondría a una
en el mostrador de la otra.

## Consecuencias

### A favor

- **Con conexión hay un solo camino, la contraseña,** y la persona no llega a un mostrador sin sesión por una elección que no necesitaba.
- **Sin red todo queda igual:** el botón está, con las mismas 72 horas.
- **Cierra el hallazgo de frontend #109** con una regla que se puede decir en una frase y que usa la misma fuente de verdad de la conexión que el resto de la aplicación.

### En contra

- **El botón puede desaparecer cuando la persona va a tocarlo:** al abrir con una red lenta, `checking` puede durar unos segundos y luego pasar a `online`.
  Tiene el formulario de la contraseña al lado, pero es un cambio de pantalla que antes no ocurría.
- **Una conexión que contesta `GET /health` pero no alcanza para entrar** (datos móviles muy lentos, un portal que deja pasar esa petición) oculta el
  botón aunque se podría vender con lo guardado. La vigilancia vuelve a preguntar cada 30 segundos y, si falla, vuelve a marcar «sin conexión» y el botón
  reaparece; mientras tanto, si el servicio de identidad no responde, la persona no entra.
- **Quien olvidó la contraseña y tiene conexión ya no puede seguir con lo guardado desde esta pantalla,** como antes durante 72 horas. Puede recuperar la
  contraseña (con el límite de 2 correos por hora del ADR 0022) o trabajar sin red; no se bloquea a propósito, porque no es una regla de seguridad.
- **Los documentos del recorrido del Ciclo 3 que citan el botón** (filas 16 y 21 del recorrido y la nota de `almacenamiento-local.md`) dicen ahora cuándo
  aparece y cuándo no.
- **No se probó en un teléfono.** Se probó en un navegador real contra la API y la base reales (la prueba de `continuar-sin-conexion.spec.ts`): con red
  el botón se oculta y al cortarla vuelve. Falta repetirlo en el teléfono de la prueba del Ciclo 3.
