# ADR 0012 — CORS con lista explícita de orígenes y sin credenciales

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 0

## Contexto

La PWA y la API son dos repositorios independientes (ADR 0001) y viven en **orígenes distintos**: en desarrollo
`http://localhost:5173` y `http://localhost:3000`; en la nube, dos dominios. El navegador aplica la política del
mismo origen: la petición sale, pero oculta la respuesta al JavaScript de la página salvo que traiga
`Access-Control-Allow-Origin` con el origen de quien llama. Sin esa cabecera, el frontend cree que no hay
conexión aunque el servicio esté en pie. Lo descubrimos al preparar la pantalla que consume `GET /health`
(C0-08).

CORS no defiende a la API de quien no usa un navegador (`curl` lo ignora). Protege a la persona que tiene
abierta nuestra aplicación de que **otro sitio** lea, desde su navegador, respuestas que llevan sus datos. Por
eso la lista de orígenes tiene que ser exacta.

## Decisión

- La variable de entorno **`CORS_ORIGINS`** lista, separados por comas, los orígenes a los que se les permite
  leer las respuestas. Cada uno se escribe como lo envía el navegador: `esquema://host[:puerto]`, `http` o
  `https`, en minúsculas, sin ruta ni barra final. La comparación es exacta.
- **Por omisión no se permite ningún origen.** Sin la variable, la API no emite cabeceras CORS.
- **Nunca el comodín.** `*` hace fallar el arranque con un mensaje que lo explica, igual que cualquier origen
  mal escrito: se prefiere que la aplicación caiga al arrancar a que arranque con una lista que nadie pensó.
- Un origen de la lista recibe `Access-Control-Allow-Origin` con **su propio valor** y `Vary: Origin`. Uno que no
  está en la lista no recibe esa cabecera.
- **Sin credenciales.** No se emite `Access-Control-Allow-Credentials`: la API usará un token en la cabecera
  `Authorization`, no cookies. El navegador, entonces, no adjunta nada por su cuenta a una petición hecha desde
  otro sitio. Si la decisión de identidad terminara usando cookies, un ADR nuevo reemplazaría este punto.
- La petición previa (`OPTIONS`) responde `204` sin cuerpo, anuncia `GET, HEAD, POST, PUT, PATCH, DELETE`,
  refleja las cabeceras que el navegador pide y puede recordarse un día (algunos navegadores recortan ese
  plazo).
- Los orígenes de cada ambiente los pone una persona en las variables de ese ambiente. No viven en el código.

## Alternativas consideradas

### El comodín `*`

Es lo más corto, pero cualquier sitio podría leer nuestras respuestas. Tampoco admite credenciales, así que nos
cerraría una puerta si algún día hicieran falta. Descartada.

### Reflejar cualquier origen

Responder con el origen que llegue equivale al comodín con credenciales permitidas, que es la configuración más
peligrosa de CORS. Descartada.

### Evitar CORS con un proxy inverso del mismo origen

Si el hosting sirviera la PWA y reenviara `/api` a la API, no habría CORS. Descartada por ahora: acopla los
despliegues que ADR 0001 quiere independientes, depende de un hosting que todavía no elegimos y obligaría a un
proxy también en desarrollo. No se excluye para más adelante.

### Una lista fija en el código

Obligaría a recompilar la imagen por ambiente, y ADR 0011 pide que la configuración llegue por variables.
Descartada.

### Patrones o subdominios (`*.vercel.app`)

Resolverían las URL cambiantes de las previsualizaciones, pero abrirían la API a cualquier proyecto alojado
en ese dominio. Descartada hasta que haga falta, y con su propio ADR.

## Consecuencias

### A favor

- Cerrado por omisión: un ambiente sin configurar no queda abierto por descuido.
- Explícito y revisable: cada origen permitido está escrito en la configuración de su ambiente.
- Sin recompilar para cambiar de ambiente.
- Las pruebas arrancan la aplicación real y comprueban las cabeceras, no la intención.

### En contra

- **Hay que acordarse de añadir el origen de cada ambiente nuevo.** Si falta, el frontend muestra «sin conexión»
  con el servicio en pie, que es un síntoma confuso. Por eso el arranque registra qué orígenes permite.
- **Las previsualizaciones con URL cambiante no funcionan** sin editar la lista.
- **CORS no es una barrera de seguridad para la API.** Quien no usa un navegador la ignora; la protección real
  es la identidad y los permisos (Ciclo 2).
- La biblioteca anuncia los métodos permitidos incluso a un origen que no está en la lista. No concede nada
  (sin `Allow-Origin` el navegador lo bloquea), pero una lectura estricta de «no recibe nada» no se cumple.

### Mitigación acordada

- Al arrancar, la API registra los orígenes permitidos (o que no hay ninguno).
- El README y `.env.example` documentan la variable; el frontend documenta qué origen debe pedir.
