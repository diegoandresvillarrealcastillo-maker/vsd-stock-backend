# ADR 0024 — Base del cliente web: rutas, sesión, cliente de la API y estructura

- **Estado:** Aceptada
- **Fecha:** 2026-10-17
- **Ciclo:** 2

## Contexto

Hasta el Ciclo 1 el cliente web era una sola pantalla: el estado de la conexión y una muestra del sistema de diseño. El
Ciclo 2 le suma las primeras pantallas de verdad (entrar, crear el negocio, el catálogo, el inventario y las compras), y
todas necesitan las mismas piezas: saber quién es la persona, hablar con la API con su token, mostrar solo lo que su rol
puede usar y decir con claridad cuando falta la conexión. Decidir esas piezas una vez, antes de la primera pantalla, evita
que cada una invente la suya.

Ya estaba decidido: la arquitectura hexagonal del cliente ([ADR 0002](0002-arquitectura-hexagonal-impuesta-por-eslint.md)), la sesión **solo en
memoria** ([ADR 0018](0018-cifrado-local-y-olvido-del-dispositivo.md)), la tabla de permisos por rol
([ADR 0017](0017-roles-permisos-y-modo-sin-conexion.md)), las clases de fallo del motor
([ADR 0009](0009-motor-offline-y-libro-de-movimientos.md)), el contrato OpenAPI como único acoplamiento
([ADR 0001](0001-dos-repositorios-independientes.md)) y que el servicio de identidad es Supabase Auth
([ADR 0022](0022-identidad-y-sesion.md)).

## Decisión

1. **Rutas con `react-router` 7, en modo declarativo** (`BrowserRouter`, `Routes` y `Route`), sin su modo «framework» ni
   enrutadores con cargadores de datos. Es una aplicación de una sola página instalable como PWA: lo que cada pantalla
   necesita lo pide por un caso de uso, no por un cargador de la ruta. El enrutador lo monta quien arranca la aplicación
   (`main.tsx`) y no la raíz, para que las pruebas usen una memoria en su lugar. Con las piezas de esta base (casi todo
   `react-router`) el JavaScript comprimido pasó de 103,3 a 119,7 KB, medido sobre la página pública (ver
   `docs/rendimiento.md` del frontend); con las pantallas del Ciclo 2 llegó a unos 145 KB.
2. **El cliente de la API es `fetch` con los tipos del contrato**, sin biblioteca de HTTP. `ApiGateway` es un puerto de
   salida; `HttpApiGateway` pone el token de la sesión, lee `Retry-After` e `Idempotent-Replayed` y devuelve
   siempre o una respuesta o un `ApiError` con su **clase de fallo** (`network`, `session`, `transient`, `conflict`,
   `permanent`: el ADR 0009). **Solo acepta rutas** (`/v1/...`), nunca direcciones completas, para que el token de la
   persona no pueda salir hacia otro servidor ni por un descuido.
3. **El estado del servidor no usa una biblioteca todavía.** Cada pantalla lo pide por un caso de uso y lo guarda en el
   componente; las listas largas se cargan con «cargar más» siguiendo el cursor. La cuenta de la persona sí se comparte
   (`AuthProvider`/`useAccount`) porque todas las pantallas la necesitan. Si en el Ciclo 3 la base local del dispositivo
   cambia de dónde se leen los datos, ahí se decide si hace falta una caché; hoy sería código que luego habría que quitar.
4. **La sesión vive solo en memoria** y el navegador habla **directo con Supabase Auth** (`fetch`, sin su biblioteca):
   entrar, registrar, renovar y salir. Los límites de uso de Supabase se cuentan por IP y, detrás de un proxy, todas las
   personas compartirían la de la API. Se configura al compilar con `VITE_AUTH_URL` y `VITE_AUTH_PUBLISHABLE_KEY`: van
   **juntas o ninguna**, y la clave es la **publicable**; una clave secreta (`sb_secret_…` o `service_role`) detiene el
   arranque, porque todo lo que se compila en un navegador lo lee cualquiera. Sin ellas la aplicación arranca y dice
   que el servicio no está disponible; no acusa de una clave mal escrita.
5. **El token se renueva solo,** un minuto antes de vencer y una renovación a la vez. Un fallo pasajero (sin red, servicio
   caído o con límite de uso) **no cierra la sesión**; solo la cierra un rechazo del servicio. Una respuesta tardía que
   llega cuando la persona ya salió o entró otra no pisa la sesión nueva.
6. **Los permisos del cliente son una copia, no una tabla propia.** `contract/permissions.json` es la tabla del backend
   (ADR 0017) copiada tal cual; `npm run contract:sync` la trae y `contract:check` (y el CI) la compara como a los demás
   contratos, diciendo qué acción apareció, desapareció o cambió de rol. El menú ofrece lo que el rol puede usar y quien
   escribe la dirección a mano ve «No tienes acceso». **Es cortesía, no seguridad:** el servidor aplica la misma tabla en
   cada petición.
7. **Las puertas de las rutas dependen del estado de la cuenta:** sin sesión, todo lleva a `/ingresar`; con sesión y sin
   negocio, a `/empezar`; con negocio, al marco de la aplicación. Si hay sesión pero no se pudo preguntar quién es la
   persona (sin red, servidor caído), la sesión **se conserva** y se ofrece reintentar o cerrarla; no se la manda a
   entrar de nuevo.
8. **Una pantalla que lista o cambia algo necesita al servidor** y, sin conexión, lo dice («Esta pantalla necesita
   conexión») en vez de mostrarse vacía o con datos viejos. Eso cambia con la base local del Ciclo 3.
9. **Estructura:** `domain/` (sesión, cuenta, permisos, navegación, fallos), `application/` (`SessionManager`, `LoadMe`),
   `adapters/out/` (identidad, sesión en memoria, API), `infrastructure/` (el cableado: `createAuth`, la configuración) y
   `presentation/` (proveedores, rutas, marco y pantallas). Solo `presentation/` conoce React y no importa adaptadores:
   recibe los casos de uso ya armados.
10. **Las pantallas comparten tres ganchos y un molde.** `useLoad` (carga, fallo con «Reintentar» y lo último que llegó
    mientras se refresca), `usePagedLoad` (listas por cursor que olvidan lo sumado cuando cambia la pregunta) y `useSubmit`
    (una acción a la vez, error dicho en una frase y por campo, y cierre de la sesión si la API dice que ya no vale). Cada
    código estable de la API (ADR 0019) tiene su frase en español y un código que no se conoce no se muestra: se dice algo
    general. Lo que falta se dice en el campo y se le da el foco antes de molestar al servidor.
11. **Las operaciones que no se pueden repetir llevan su llave** (ADR 0019): cada pantalla de ajuste o de compra genera su
    `operationId` **una sola vez**; si el envío falla se reintenta con la misma, y si el servidor responde que ya la había
    aplicado (`Idempotent-Replayed`) la pantalla lo dice. Cambiar los datos tras un fallo incierto devuelve
    `operation-id-reused`, y la pantalla manda a revisar lo guardado en vez de adivinar.
12. **Los números no se adivinan.** Un precio son solo dígitos; una cantidad usa la coma para los decimales y rechaza el
    punto, porque «1.500» podría ser uno y medio o mil quinientos. Lo que se cuenta de a uno no admite fracciones. El IVA
    que va dentro de un precio se separa con la misma regla del servidor (ADR 0014), y el día y la hora se escriben a mano
    para que salgan igual en cualquier navegador.

## Consecuencias

### A favor

- Cada pantalla nueva parte de lo mismo: quién es la persona, cómo habla con la API, qué ve según su rol y cómo dice un
  error. Lo que se repetía se resolvió una vez en los ganchos del punto 10, sin sumar una dependencia.
- Un permiso cambiado en el backend deja el contrato del frontend en rojo hasta que se sincroniza: nadie se entera por
  una pantalla que falla.
- El token nunca puede salir hacia otro servidor ni quedarse guardado en el equipo, y una operación que no se puede repetir
  no se cuenta dos veces aunque la respuesta se pierda.
- Una cantidad mal escrita se rechaza con una frase en vez de adivinarse y descuadrar el inventario.

### En contra

- **Recargar la página cierra la sesión** y pide la contraseña otra vez. Es lo que evita dejar una credencial en el
  equipo de otra persona, y lo que el dueño del proyecto aceptó; si molesta en el mostrador se vuelve a discutir con
  datos (ADR 0018). La sesión sin conexión de 72 horas del ADR 0017 todavía no existe en el cliente: llega con el motor
  del Ciclo 3.
- **Dos copias de la tabla de permisos que hay que mantener iguales** (la del servidor y la del cliente); el CI lo
  vigila, pero un cambio de rol en el backend deja el contrato del frontend en rojo hasta que se sincroniza.
- **Sin biblioteca de estado del servidor,** cada pantalla pide lo suyo y no hay caché ni deduplicación. Si con la base
  local del Ciclo 3 hace falta, se decide entonces.
- **La lista de categorías no dice cuántos productos tiene cada una** y la de compras no abre el detalle ni calcula
  totales: el contrato de hoy no los da. Se agregan al contrato cuando alguien los pida.
- **Una lista que se refresca no siempre muestra lo último al instante:** mientras se pide de nuevo se sigue viendo la
  anterior. Es mejor que una pantalla que parpadea, pero por un momento puede estar vieja.
- **El navegador conoce la dirección y la clave publicable de Supabase:** son públicas por diseño, pero una clave
  secreta puesta por error ahí sería pública de inmediato; por eso se rechaza al arrancar.

## Alternativas consideradas

- **TanStack Query para el estado del servidor.** Resuelve caché, reintentos y deduplicación, pero con la base local del
  Ciclo 3 la fuente de verdad cambia y parte de lo que da dejaría de servir. Se reconsidera allí.
- **`@supabase/supabase-js`.** Maneja la sesión y la renovación, pero guarda la sesión en `localStorage` por omisión
  (contra el ADR 0018), pesa cientos de kilobytes y trae su propio manejo de errores. Con `fetch` son cuatro llamadas.
- **Que el navegador hable con Supabase a través de la API (un proxy).** Escondería la dirección de Supabase, pero
  todas las personas compartirían la IP de la API para los límites de uso y la API pasaría a ver las contraseñas.
- **Enrutadores con cargadores de datos (`createBrowserRouter`).** Acoplan la carga de datos a la ruta; aquí cada
  pantalla pide lo suyo por un caso de uso y se prueba sin enrutador.
