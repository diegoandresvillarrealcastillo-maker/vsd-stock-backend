# ADR 0031 — Los hosts de PRE: la API en Render y la web en Cloudflare Pages

- **Estado:** Aceptada
- **Fecha:** 2026-10-20
- **Ciclo:** 3

## Contexto

PRE tiene su base de datos (el proyecto de Supabase, ADR 0025) pero no tiene dónde correr la API ni dónde servir la web. Sin ellos
no se puede probar nada en un teléfono, y **un teléfono es lo que decide si este ciclo funcionó**: el modo sin conexión necesita
el service worker, el cifrado de lo guardado necesita WebCrypto y la cámara para leer códigos necesita el permiso del navegador, y
**los tres existen solo en una página servida por HTTPS** (ADR 0018, punto 9). El [ADR 0011](0011-el-backend-se-empaqueta-como-imagen-de-docker.md)
dejó dicho que la API es una imagen de Docker y que **dónde se despliega es otro ADR**; este es ese ADR.

Las condiciones, que vienen de este proyecto y no del mercado:

- **PRE no es un negocio:** trabaja con datos ficticios y lo usan el equipo y, a lo sumo, una persona de prueba. No hace falta que
  esté siempre despierto, y no se paga nada por él (el proyecto de Supabase ya consume los dos proyectos activos del plan gratuito).
- **Lo crea una persona**, en paneles que el asistente de código no opera. Lo que el repositorio puede dar es la configuración sin
  secretos, los pasos uno por uno y una comprobación que se corre desde fuera.
- **PROD sigue en pausa:** nada de lo que se decide aquí lo crea ni lo configura (`docs/ambientes.md`).
- **El plazo de entrega no se mueve:** lo que se elija tiene que poder estar en pie en un día, por una persona que no es de
  infraestructura.

## Decisión

1. **La API corre en Render**, como servicio web de tipo Docker (la misma imagen del ADR 0011), en el **plan gratuito**, en la
   región _Virginia_ (la más cercana al proyecto de Supabase de PRE, que está en AWS us-east-1: cada consulta cruza esa distancia).
   Se describe en `render.yaml` (un Blueprint) y se conecta **una vez** desde el panel.
2. **La web se sirve desde Cloudflare Pages**, en su plan gratuito: compila el repositorio del frontend (`npm run build`) y publica
   `dist/`. Sirve la aplicación desde cualquier ruta cuando el sitio no trae un `404.html` propio (es una aplicación de una sola
   página), y lee las reglas de caché de `public/_headers`.
3. **Los dos siguen la rama `preproduccion`.** Nada llega a PRE hasta que el dueño del proyecto aprueba la promoción
   `desarrollo → preproduccion` (ADR 0010). `render.yaml` fija la rama y el despliegue automático por _commit_ **de esa rama**.
4. **`render.yaml` no lleva ningún secreto.** Lo que depende de PRE o lleva una contraseña (`DATABASE_URL`, `CORS_ORIGINS`,
   `AUTH_ISSUER` y `AUTH_JWKS_URL`) se pide en el panel al crear el servicio (`sync: false`) y vive solo ahí. Una prueba
   (`test/docs/despliegue.spec.ts`) lo vigila: ninguna variable con aspecto de secreto trae su valor escrito, y **la conexión del dueño
   de las tablas (`DATABASE_MIGRATION_URL`) nunca se le da a la API**: solo migra, a mano, desde la máquina de una persona (ADR 0021).
5. **La comprobación comprueba desde fuera, y una persona la corre:** `npm run verify:deploy -- <API> <WEB>` hace unas diez peticiones
   HTTP y nada más (no toca la base ni pide ninguna clave). Verifica que las dos direcciones sean HTTPS; que la API responda en
   `/health`; **cuánto tardó en despertar**; que siga rápida una vez despierta; que llegue a su base (`/v1/ready`); que rechace una
   llamada sin sesión; que dé permiso de CORS **solo** a la web de PRE y a nadie más (ADR 0012); y que la web sirva la aplicación desde
   cualquier ruta, publique el manifiesto y el service worker **sin caché larga** (para que una versión nueva se encuentre) y guarde un
   año los archivos con huella. Imprime un informe y ningún secreto; sale con 0 solo si todo pasó.
6. **La API gratuita se duerme y la aplicación lo sabe:** tras 15 minutos sin tráfico Render la duerme y tarda alrededor de un minuto
   en despertarla. Para la aplicación eso es «el servidor no responde»: el panel «Estado del servicio» dice «Sin conexión» hasta que
   despierta, **y no se pierde nada**, porque lo que se hizo sin conexión espera en el equipo (ADR 0029) y el motor de envío reintenta
   (ADR 0030). `verify:deploy` mide ese despertar la primera vez.
7. **Los límites que se aceptan**, verificados el **2026-10-19** en la documentación de cada host:

   | Host                      | Límite                                                                                                         |
   | ------------------------- | -------------------------------------------------------------------------------------------------------------- |
   | Render, servicio gratuito | Se duerme a los 15 minutos sin tráfico y tarda alrededor de un minuto en despertar.                            |
   |                           | 750 horas de instancia por mes y por espacio de trabajo; si se acaban, se suspende hasta el mes siguiente.     |
   |                           | Una sola instancia, sin disco persistente (lo local se pierde al reiniciar), sin caché de borde, sin terminal. |
   |                           | Salida bloqueada por los puertos 25, 465 y 587 (sin correo saliente). Puede reiniciarse en cualquier momento.  |
   | Cloudflare Pages          | 500 compilaciones por mes (una a la vez), 20.000 archivos por sitio y 25 MiB por archivo.                      |
   |                           | `_headers` (hasta 100 reglas) y `_redirects` (hasta 2.100) se leen del propio sitio.                           |

8. **Se vuelve atrás desde el panel de cada host** (_Rollback_ al despliegue anterior). Una migración **no** se revierte sola
   (`docs/ambientes.md`).

## Alternativas consideradas

- **Todo en Vercel** (la API como funciones y la web como sitio): la API de este proyecto es un servidor NestJS con conexiones a la base
  por un pooler y no una función de un solo uso; adaptarla tocaría el empaquetado que el ADR 0011 ya decidió y el arranque en frío
  de una función con Prisma es peor que el de un contenedor.
- **Fly.io o Railway para la API:** funcionan con la misma imagen, pero **piden tarjeta** desde el principio y ofrecen un crédito, no
  un plan gratuito permanente. Para un ambiente que se usa unas horas por semana, un costo que puede sorprender es peor que una
  espera de un minuto.
- **Render también para la web (sitio estático):** simplifica una cuenta, pero Cloudflare Pages tiene **más márgenes** (compilaciones,
  ancho de banda sin tope declarado para archivos estáticos), una red de entrega de contenido y reglas de caché por archivo
  (`_headers`), que es justo lo que el service worker necesita.
- **Un servicio de pago que no se duerma** (Render _Starter_): quita la espera, cuesta dinero cada mes y no cambia nada de lo que hay
  que probar. Queda como el paso natural **si PRE empieza a usarse a diario**, y es un cambio de `plan:` en `render.yaml`.
- **Un VPS propio:** control total, pero una persona tendría que mantener un sistema operativo, el certificado y las actualizaciones
  para un ambiente de pruebas.
- **Mantener la API despierta con un ping periódico:** es una trampa. Quema las 750 horas del mes en unas semanas y el límite
  suspende el servicio entero; y esconde justo lo que PRE tiene que enseñar: que la aplicación aguanta una API lenta.
- **Servir la web desde la propia API:** mezcla dos ciclos de vida (una versión de la interfaz no es una versión de la API), obliga a
  que la API entregue archivos estáticos y quita el CORS explícito del ADR 0012, que se mantiene aunque ambos vivan en hosts distintos.

## Consecuencias

### A favor

- **PRE tiene HTTPS, que es lo que decide si el service worker, el cifrado y la cámara funcionan en un teléfono**, sin pagar nada.
- **Lo que se despliega es lo mismo que corre el CI** (la imagen del ADR 0011), así que no hay una configuración de producción
  distinta que solo se vea al desplegar.
- **Sin secretos en el repositorio:** la configuración se puede versionar, revisar y copiar, y lo secreto vive en dos paneles.
- **Una persona que no es de infraestructura puede hacerlo en una tarde**, siguiendo una lista, y comprobarlo con un comando que no
  le pide ningún secreto.
- **Que la API se duerma obliga a la aplicación a ser honesta con la espera**, que es lo que había que demostrar.

### En contra

- **La primera petición tras un rato sin uso espera alrededor de un minuto**, y mientras tanto la aplicación dice «Sin conexión»; un
  teléfono que abre la aplicación después de un día vería esa espera. En PRE se acepta; **en PROD no sería aceptable** y habría que
  pasar a un plan que no se duerma (un ADR nuevo).
- **Las 750 horas por mes se acaban** si la API se mantiene despierta todo el tiempo (por ejemplo, con un recorrido largo de pruebas
  todos los días): el servicio se suspende hasta el mes siguiente. Hoy se duerme sola, así que no ocurre.
- **Sin disco persistente ni correo saliente:** la API no los usa, pero cualquier ticket futuro que los necesite (archivos
  adjuntos, notificaciones por correo) tendrá que cambiar de plan o de host.
- **Dos paneles y dos cuentas** que alguien tiene que cuidar, y dos sitios donde mirar cuando algo falla.
- **Una dirección distinta del servicio de identidad, de la API y de la web:** `CORS_ORIGINS` debe ser la dirección **exacta** de la web
  y un error ahí se ve como «blocked by CORS policy» en la consola del navegador; `verify:deploy` lo dice, pero hay que correrlo.
- **El tiempo de despertar y la red de un teléfono se miden una vez** (C3-16) y no se vigilan: no hay monitoreo continuo en PRE.
- **Depende de que Render y Cloudflare mantengan estos planes gratuitos:** si los cambian, este ADR se reemplaza con otro.
