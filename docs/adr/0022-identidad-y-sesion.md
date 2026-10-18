# ADR 0022 — Identidad y sesión: quién llama, a qué negocio pertenece y cuánto dura

- **Estado:** Aceptada
- **Fecha:** 2026-10-17
- **Ciclo:** 2

## Contexto

La seguridad por fila ([ADR 0005](0005-aislamiento-por-negocio-en-la-base-de-datos.md)) exige que la API sepa el
negocio de quien llama **antes** de leer una sola fila, y que lo saque de un token verificado y nunca de lo que el
cliente declare. El [ADR 0017](0017-roles-permisos-y-modo-sin-conexion.md) dejó sin decidir cómo se identifica a la
persona y cuánto dura una sesión sin conexión; el [ADR 0018](0018-cifrado-local-y-olvido-del-dispositivo.md) fijó que
los tokens de acceso viven solo en memoria y advirtió que eso complica la sesión sin conexión. El dueño del proyecto
aceptó **Supabase Auth** como servicio de identidad (2026-10-17), con invitaciones por código para sumar personas y sin
login propio.

Lo que Supabase ofrece y lo que no, verificado en su documentación ese día: firma los tokens con una clave asimétrica
si el proyecto la usa y publica las claves públicas en
`https://REF.supabase.co/auth/v1/.well-known/jwks.json` (la lista viene **vacía** si el proyecto sigue con el secreto
compartido); el token de una persona lleva `iss = https://REF.supabase.co/auth/v1`, `aud = authenticated`,
`role = authenticated` y `sub` con el UUID de la persona; el correo integrado envía solo **2 correos por hora**; los
límites de inicio de sesión se cuentan **por dirección IP** de quien llama.

## Decisión

1. **La identidad la da Supabase Auth; la API solo la verifica.** Comprueba cada token con las claves **públicas** del
   proyecto (JWKS) y con `jose`. La API no guarda ni conoce ninguna contraseña, ninguna clave secreta de Supabase ni
   la clave `service_role`.
2. **Solo se aceptan firmas asimétricas** (`ES256`, `RS256`, `EdDSA`). Un token sin firma (`alg: none`) o firmado con un
   secreto compartido (`HS256`) se rechaza aunque diga todo lo correcto: es la forma clásica de colar un token falso.
3. **Qué se exige de un token:** firma válida, `iss` y `aud` exactos de la configuración, `role = authenticated`
   (Supabase también firma las claves anónima y de servicio), `sub` con forma de UUID y `exp` e `iat` presentes. Se
   toleran **5 segundos** de diferencia entre relojes. Si faltan las claves del servicio, la respuesta es 503 y no 401:
   no es culpa del token.
4. **Las claves públicas se recuerdan a lo sumo 10 minutos** (lo que Supabase guarda en su borde) y ante un `kid`
   desconocido se vuelven a pedir, con una espera mínima de 30 segundos entre pedidos para que un token falso no nos
   haga martillar al servicio. Así una rotación de claves no desloguea a nadie.
5. **El negocio y el rol salen de nuestra base, nunca del token.** El `sub` es la llave: la API busca la fila de
   `app_user` con `auth_user_id = sub` usando la política `identity_lookup` ([ADR 0021](0021-esquema-real-y-primera-migracion.md),
   punto 7) y de ahí saca el negocio, el rol y si está activa. Nada de `app_metadata` ni de reclamaciones propias:
   cambiar un rol es una escritura en nuestra base y vale desde la siguiente petición, sin esperar a que venza un token.
6. **Dar de baja surte efecto en línea de inmediato.** Como se consulta la fila en cada petición, una persona dada de
   baja recibe 403 `user-inactive` aunque su token siga vigente (una hora, por omisión en Supabase).
7. **`GET /v1/me` es «quién soy».** Devuelve a la persona y, si ya tiene negocio, el suyo y su rol. Una persona que se
   registró pero aún no creó un negocio ni canjeó una invitación recibe **200 con `membership: null`**: es un estado
   normal del flujo de entrada, no un error.
8. **Códigos de error estables** (ADR 0019), iguales para todo endpoint de una persona: `unauthenticated` (sin
   credenciales o no es un `Bearer`), `token-expired` (venció: el cliente lo renueva en lugar de pedir la contraseña),
   `invalid-token` (**el mismo mensaje para toda causa**: decir por qué se rechazó enseñaría a falsificar uno),
   `identity-unavailable` (503 con `Retry-After: 5`), `identity-not-configured` y `user-inactive` (403). La traducción
   del error del dominio a HTTP vive en un solo lugar (el filtro), para que ningún endpoint tenga que acordarse.
9. **El navegador habla con Supabase Auth directamente,** con la clave **publicable** (que es pública por diseño), y
   manda el token a nuestra API en la cabecera `Authorization: Bearer`. No hay un proxy: los límites de Supabase se
   cuentan por IP y, detrás de un proxy, todas las personas compartirían la de la API y se bloquearían entre sí.
10. **Sesión del cliente.** El token de acceso vive **solo en memoria** ([ADR 0018](0018-cifrado-local-y-olvido-del-dispositivo.md),
    punto 6, sin cambios). **Tampoco se guarda el token de renovación:** recargar la página con conexión pide de nuevo
    la contraseña, con la persona ya elegida (su base local se llama como su UUID). Es el precio de no guardar una
    credencial en el dispositivo, y se mide con el teléfono real en el Ciclo 3 (ver «En contra»).
11. **Sesión sin conexión.** Al iniciar sesión con conexión, el cliente anota **dentro de la base cifrada de la persona**
    un registro no secreto —quién es, su negocio, su rol y la hora de la última verificación—. Sin conexión, el
    mostrador (el trabajo que el ADR 0017 permite sin red, abierto a los tres roles) **se reanuda con ese registro hasta
    72 horas después de la última verificación**, el mismo límite tras el cual una operación se marca `stale` (ADR 0016).
    Pasado ese plazo la interfaz se **bloquea** y la base cifrada se **conserva** (ADR 0018, punto 8) hasta volver a
    iniciar sesión con conexión. Lo hecho sin red lo revalida el servidor al sincronizar: basta que la persona
    pertenezca al negocio y, si fue dada de baja mientras tanto, la venta se acepta y se marca (ADR 0017, punto 10).
12. **El servicio de identidad es una dependencia configurable, no una ruta de pruebas.** Las variables son
    `AUTH_ISSUER`, `AUTH_JWKS_URL` y `AUTH_AUDIENCE` (por omisión `authenticated`): se configuran **las tres juntas o
    ninguna**, y la clave pública no puede venir por `http` desde otra máquina. En las pruebas y el desarrollo local un
    emisor de mentira (`test/support/fake-identity-provider.ts`) publica sus claves y firma tokens, y la API lo
    verifica con **el mismo código** que usa con el proyecto real; la prueba contra un proyecto real es el ticket C2-13.
13. **La tabla de permisos viaja por el contrato.** `contract/permissions.json` sale del dominio
    (`npm run permissions`) y el frontend guarda una copia que se compara, como los vectores de cálculo: el cliente
    decide qué ofrecer con la misma tabla que el servidor aplica.

## Alternativas consideradas

### Un login propio (contraseña con hash y token firmado por la API)

Es lo que usaba el VSD Stock anterior y no dependería de un servicio externo en desarrollo. Pero la seguridad de las
contraseñas, el bloqueo de intentos, la renovación y la revocación de tokens y, sobre todo, «olvidé mi contraseña»
pasarían a ser código nuestro y superficie de riesgo; y sin correo, el último dueño que olvida su contraseña no tiene
salida. Con Supabase Auth se paga con una dependencia que las pruebas aíslan con el emisor de mentira.

### Verificar con el secreto compartido (HS256)

Más simple de programar, pero obligaría a tener en la API un secreto que **cualquiera que lo lea puede usar para hacerse
pasar por cualquier persona**. Con claves asimétricas la API solo tiene lo que ya es público.

### Poner el negocio y el rol dentro del token (reclamaciones propias)

Ahorraría una consulta por petición, pero un rol cambiado o una baja no valdrían hasta que venciera el token, y
exigiría una clave poderosa en la API para escribir las reclamaciones. La consulta por petición cuesta un acceso corto a
una fila indexada.

### Que la API haga de proxy del inicio de sesión

Mantendría la clave de Supabase fuera del navegador (no hace falta: la publicable es pública) y centralizaría el
registro, pero haría compartir la IP de todos los usuarios y duplicaría un servicio que ya existe.

### Guardar el token de renovación cifrado en el dispositivo

Evitaría pedir la contraseña al recargar. Pero es una credencial que sirve **desde cualquier lugar** y reemplaza a la
contraseña, y el ADR 0018 decidió que nada secreto se guarda en la base. Queda como mejora posible, con su ADR, si la
prueba con el teléfono real muestra que pedir la contraseña molesta demasiado.

### Dejar la sesión sin conexión sin límite

Un teléfono olvidado seguiría vendiendo para siempre sin que nadie lo verifique. Setenta y dos horas coinciden con el
límite que ya usa la sincronización para llamar «vieja» a una operación.

## Consecuencias

### A favor

- La API no guarda ni un secreto de identidad: lo único que necesita para verificar es público.
- Un rol cambiado o una persona dada de baja valen en la siguiente petición, sin esperar a que venza un token.
- Un token falso falla por razones que las pruebas recorren una por una (firma, algoritmo, vencimiento, emisor,
  destinatario, rol, forma del `sub`), y quien lo intenta no aprende cuál fue.
- Una caída del servicio de identidad se distingue de un token malo (503 frente a 401): el cliente no cierra sesión por
  un fallo ajeno.

### En contra

- **Dependemos de Supabase Auth,** incluida su disponibilidad: si no responde y no tenemos sus claves recientes, nadie
  nuevo entra. Las claves ya conocidas se recuerdan hasta 10 minutos.
- **Recargar la página con conexión pide la contraseña,** y en un teléfono que el sistema recarga a menudo (una
  aplicación instalada que se cierra por memoria) eso puede cansar. Es una decisión consciente a favor de no guardar
  una credencial; se mide en el Ciclo 3.
- **El correo integrado de Supabase envía 2 por hora:** la confirmación de correo queda apagada en PRE y «olvidé mi
  contraseña» casi no es usable hasta tener un correo propio. En producción hay que configurarlo (deuda con ADR).
- **Una consulta a la base por cada petición** para saber el negocio y el rol. Es corta, pero la API ya no puede
  atender nada de una persona si la base no responde.
- **El token vale una hora** aunque la persona cierre sesión en otro lugar: no hay lista de revocación. La baja la
  cubre la consulta por petición; un cierre de sesión remoto no.
- **Lo que dice la documentación de Supabase puede cambiar** (nombres de claves, plazos, límites). Se verificó el
  2026-10-17; C2-13 lo vuelve a verificar con un token real.
- **Se tolera un desfase de reloj de 5 segundos:** un token vencido hace menos de eso todavía pasa.
- **Una persona solo pertenece a un negocio** (`auth_user_id` es único en `app_user`). Cambiarlo es un ADR.

### Mitigación acordada

- C2-13 verifica un token real de un proyecto de PRE y que la lista de claves del proyecto no está vacía.
- Las pruebas del verificador recorren cada rechazo con un token fabricado para ese caso, y las de extremo a extremo
  recorren el camino completo con la base real.
- El Ciclo 3 mide en un teléfono real cuántas veces se pide la contraseña; si es demasiado, se abre un ADR para guardar
  el token de renovación cifrado.
