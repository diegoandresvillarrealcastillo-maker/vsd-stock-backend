# Plan de ambientes

Dónde corre VSD Stock, qué hay hoy, qué falta, y los pasos manuales que le tocan a la persona que opera los
paneles (GitHub, Supabase y los hosts). **PROD está en pausa.**

> **Quién hace qué.** El asistente de código **no opera paneles externos** ni aplica migraciones: escribe lo que
> hace falta y dice **exactamente** qué hacer, paso a paso. Lo hace una persona. Este documento es esa lista.

## Los ambientes

| Ambiente  | Rama               | Para qué                                                  | Dónde corre                                                              | Datos                      | Estado                                                         |
| --------- | ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------- | -------------------------------------------------------------- |
| **Local** | tu rama de trabajo | Desarrollar y probar en tu equipo.                        | Tu máquina: la API en `localhost:3000`, el frontend en `localhost:5173`. | Base de trabajo en Docker. | **Disponible**                                                 |
| **DEV**   | `desarrollo`       | Integrar. Es la rama donde entra todo lo revisado.        | No tiene servidor: la verifica el CI de GitHub en cada PR y cada push.   | Base desechable del CI.    | **Disponible**                                                 |
| **PRE**   | `preproduccion`    | Probar con el equipo, con datos ficticios, antes de PROD. | Un proyecto de Supabase, un host para la API y un host para la web.      | Ficticios.                 | **Supabase listo**; hosts: [crearlos](#crear-los-hosts-de-pre) |
| **PROD**  | `produccion`       | Lo que usan los negocios de verdad.                       | Igual que PRE, aparte.                                                   | Reales.                    | **En pausa**                                                   |

La cadena es `tu rama → desarrollo → preproduccion → produccion` (ADR 0010). La rama por defecto de los dos
repositorios es `produccion`, así que cada PR indica su base de forma explícita: `--base desarrollo`.

### PROD en pausa

Mientras no se diga lo contrario **no se configura, no se promueve y no se prueba contra ella**: ni el proyecto
de Supabase, ni el host de la API, ni el de la web, ni las variables, ni el dominio. Quien levante la pausa es
el dueño del proyecto, por escrito. Se propone que lo primero sea un ADR con lo que hay que preparar (copias de
seguridad, quién atiende un incidente, qué pasa con los datos de los negocios). El paso a paso para crearla, con los comandos y las variables, está
escrito en [Crear producción](produccion.md): no la levanta, solo deja lista la lista.

## Local

Requisitos: **Node 24** (la versión exacta está en `.nvmrc` de cada repositorio) y npm. **Docker Desktop** solo
si vas a correr las pruebas de integración.

**Backend** (`vsd-stock-backend`):

```bash
npm ci
cp .env.example .env      # y ajusta los valores; el .env nunca se sube
npm run build
npm start                 # escucha en el puerto de PORT (3000 por defecto)
```

**Frontend** (`vsd-stock-frontend`):

```bash
npm ci
npm run dev               # http://localhost:5173
```

**Para comprobar que se hablan:** abre el frontend; el panel «Estado del servicio» debe decir «En línea». Si dice
«Sin conexión» con el backend en marcha, mira la consola del navegador: casi siempre es `CORS_ORIGINS`
([ADR 0012](adr/0012-cors-con-lista-explicita-de-origenes-y-sin-credenciales.md)).

**Base de datos de trabajo** (para las pruebas de integración y para ver el esquema real):

```bash
npm run db:up             # PostgreSQL 17 en Docker, publicado solo en 127.0.0.1:5433
npm run db:prepare        # crea los roles y el esquema real (las migraciones, aplicadas con Prisma)
npm run test:integration  # también prepara la base solo; db:prepare es para mirarla con otra herramienta
npm run db:down
```

`db:prepare` y las pruebas **borran y recrean el esquema `public`** de esa base: por eso se niegan a correr contra
cualquier base que no sea local y cuyo nombre no termine en `_test`.

No lleva contraseña ni datos reales: es una base desechable. En Windows, Docker Desktop puede instalarse por
usuario y no arrancar solo: si `npm run db:up` dice que no encuentra el demonio, ábrelo a mano.

### Probar todo junto en tu máquina (sin Supabase)

Para recorrer la aplicación completa —entrar, abrir un negocio, invitar, ajustar existencias y comprar— sin un
proyecto de Supabase: la base de trabajo, la API y un **servicio de identidad de mentira** que habla como Supabase Auth
en lo único que usan el frontend y la API. Es lo que se hace al cerrar cada ciclo, y lo que se repite contra PRE cuando
exista.

```bash
# 1. La base, con el esquema real (terminan solos)
npm run db:up
npm run db:prepare

# 2. El servicio de identidad de mentira: se queda corriendo e imprime las variables que siguen
npm run dev:identity          # http://127.0.0.1:54321/auth/v1; con --port elige otro

# 3. La API, en otra terminal, con lo que imprimió el paso 2 (en bash; en PowerShell, `$env:NOMBRE = "valor"`)
npm run build
DATABASE_URL=postgresql://stock_app@127.0.0.1:5433/stock_test \
AUTH_ISSUER=http://127.0.0.1:54321/auth/v1 \
AUTH_JWKS_URL=http://127.0.0.1:54321/auth/v1/.well-known/jwks.json \
CORS_ORIGINS=http://localhost:5173 \
npm start
```

En `vsd-stock-frontend`, en su `.env.local` (no se sube): `VITE_API_URL=http://localhost:3000`,
`VITE_AUTH_URL=http://127.0.0.1:54321/auth/v1` y `VITE_AUTH_PUBLISHABLE_KEY=sb_publishable_desarrollo_local`; después,
`npm run dev`. Lo que se recorre y lo que se espera en cada pantalla está en el frontend, en
`docs/recorrido-del-ciclo-2.md`.

Lo que conviene saber del servicio de mentira:

- **Es solo para desarrollo.** No valida correos, acepta cualquier clave de 6 o más caracteres, escucha solo en
  `127.0.0.1` y guarda a las personas en memoria: se pierden al apagarlo. Las claves con que firma los tokens también
  cambian en cada arranque, así que una sesión guardada en el navegador deja de valer.
- Con `--confirm-email`, registrarse **no** entrega sesión, como un proyecto de Supabase que pide confirmar el correo.
- **No prueba nada de Supabase**: ni el correo de confirmación, ni los límites de uso, ni el modo de claves del
  proyecto. Eso lo cubre `npm run verify:pre` contra PRE ([ADR 0025](adr/0025-verificacion-de-pre-contra-supabase.md)).
- Lo que sí comparte con el proyecto real es el código que verifica los tokens: la API usa el mismo verificador con las
  claves públicas de uno y de otro, así que no hay una ruta de pruebas que el código de verdad no recorra.

## Variables de entorno

Cada ambiente configura estas variables **en su propio panel**, nunca en el repositorio. Quien añada una
variable nueva la documenta aquí y en el README en el mismo PR (una prueba lo comprueba para las del
`.env.example` del backend).

| Variable                 | Repositorio | Cuándo se fija  | Qué es                                                                                                                                                                                                                                                                                             | Local                                                                                                      | PRE                                                                                                           |
| ------------------------ | ----------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `PORT`                   | backend     | Al arrancar     | Puerto en el que escucha la API.                                                                                                                                                                                                                                                                   | `3000`                                                                                                     | El que dé el host.                                                                                            |
| `CORS_ORIGINS`           | backend     | Al arrancar     | Orígenes, separados por comas, a los que se les permite leer las respuestas desde un navegador.                                                                                                                                                                                                    | `http://localhost:5173`                                                                                    | La dirección **exacta** del frontend de PRE, sin barra final.                                                 |
| `VITE_API_URL`           | frontend    | **Al compilar** | Dirección de la API. Todo lo que lleva el prefijo `VITE_` llega al navegador: nunca un secreto.                                                                                                                                                                                                    | `http://localhost:3000`                                                                                    | La dirección de la API de PRE.                                                                                |
| `DATABASE_MIGRATION_URL` | backend     | Al migrar       | Conexión del rol **dueño** de las tablas, solo para `npm run db:migrate` y el CLI de Prisma. La API no la lee. Lleva contraseña: va en tu `.env`, nunca en un chat ni en el repositorio.                                                                                                           | No hace falta: usa `npm run db:prepare`.                                                                   | La conexión del rol `postgres` por el **pooler de sesión** (puerto 5432); la aplica una persona.              |
| `DATABASE_URL`           | backend     | Al arrancar     | Conexión de la **aplicación** a la base de datos, con el rol `stock_app` (nunca el dueño de las tablas). Lleva contraseña: va en tu `.env` o en el panel del host, nunca en un chat ni en el repositorio. Sin ella la API arranca, pero `GET /v1/ready` responde 503.                              | Opcional. Para trabajar contra la base local: la misma de `npm run db:prepare` con el usuario `stock_app`. | La conexión del rol `stock_app` por el **pooler de sesión** (puerto 5432), con el usuario `stock_app.TU-REF`. |
| `AUTH_ISSUER`            | backend     | Al arrancar     | Quién firma los tokens (`iss`): `https://TU-REF.supabase.co/auth/v1`. Se compara tal cual, sin normalizar. Va junto con `AUTH_JWKS_URL` o no va.                                                                                                                                                   | Opcional. En desarrollo y en el CI lo da un emisor de mentira (`test/support/fake-identity-provider.ts`).  | El emisor del proyecto de PRE.                                                                                |
| `AUTH_JWKS_URL`          | backend     | Al arrancar     | Dónde el servicio publica sus claves **públicas**: `https://TU-REF.supabase.co/auth/v1/.well-known/jwks.json`. Con `https`, o `http` solo para esta máquina. La lista debe traer al menos una clave: si viene vacía, el proyecto sigue con el secreto compartido (ver el paso a paso de Supabase). | Opcional.                                                                                                  | La del proyecto de PRE.                                                                                       |
| `AUTH_AUDIENCE`          | backend     | Al arrancar     | Para quién son los tokens (`aud`).                                                                                                                                                                                                                                                                 | `authenticated`                                                                                            | `authenticated`                                                                                               |

Las tres de identidad se configuran **juntas o ninguna** (ADR 0022).

- Una variable mal escrita **detiene el arranque** con un mensaje que la nombra. Es a propósito.
- `CORS_ORIGINS` y `VITE_API_URL` tienen que **coincidir entre sí**: cada una nombra al otro lado. Si se
  cambia el dominio de uno, se cambia la variable del otro y, como `VITE_API_URL` se fija al compilar, **se
  vuelve a compilar el frontend**.

## Secretos

- **Viven en el panel de cada servicio** (el host, Supabase, los secretos de GitHub Actions), nunca en el
  repositorio, un chat, un ticket, un PR ni un archivo. Gitleaks revisa todo el historial en cada PR.
- Una clave pegada por error **se considera comprometida**: se rota en su panel, no se «borra del historial».
- El `.env` local no se sube (lo ignora `.gitignore`) y cada persona tiene el suyo.

## Preparar PRE

Es la lista para quien opera los paneles. **Los pasos 2 a 4 (el proyecto de Supabase, el rol de la aplicación, las
migraciones y su verificación) ya se hicieron y pasaron**: ver [Estado de PRE](#estado-de-pre). Los pasos 1 y 5 a 9 son
del ciclo que despliegue PRE: esta lista no elige hosts, **dónde se despliega es un ADR** (ADR 0011). Cada punto dice
qué hacer y qué comprobar después.

1. **Decidir los hosts.** Un host para la API (corre la imagen de Docker del backend, ADR 0011) y uno para la
   web (sirve `dist/`). Decidido en el [ADR 0031](adr/0031-hosts-de-pre-render-y-cloudflare-pages.md); los pasos están en
   [Crear los hosts de PRE](#crear-los-hosts-de-pre).
2. **Crear el proyecto de Supabase de PRE**, aparte del de cualquier otro ambiente. Anota dónde guardas su
   contraseña (un gestor de contraseñas, no un archivo). _Comprobar:_ conecta con el **pooler**; en la versión
   anterior de VSD Stock el host directo solo publicaba IPv6 y no resolvía desde algunas redes, así que
   confírmalo al crearlo. Se usa el pooler **de sesión** (puerto 5432), no el transaccional (ADR 0025).
3. **Crear el rol de la aplicación** (`stock_app`, sin privilegios: no propietario de las tablas, no
   superusuario, sin `BYPASSRLS`, ADR 0005). En el SQL Editor, con una contraseña de 32 letras y números que solo
   vive en tu gestor de contraseñas (borra después la consulta guardada, porque lleva la contraseña):

   ```sql
   create role stock_app login password 'PEGA_AQUI_LA_CONTRASENA'
     nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
   grant usage on schema public to stock_app;
   ```

   Apaga también la **Data API** (Integrations → Data API) y quita los permisos por omisión del esquema `public`
   (ADR 0021): el paso a paso con todo el SQL está en el ticket C2-13.

4. **Aplicar las migraciones, una persona**, con `npm run db:migrate`. Pon en tu `.env`
   `DATABASE_MIGRATION_URL` (rol `postgres`, pooler de sesión, puerto 5432). El comando **muestra a qué host apunta la
   conexión, sin la contraseña, y pide escribir el host para confirmar**: una migración sobre el ambiente equivocado
   no se deshace. Una migración ya aplicada no se edita (el ajuste va en una nueva) y `prisma migrate reset` está
   prohibido. La migración se niega a correr si falta el rol `stock_app`.
   **Comprobar PRE antes de seguir:** con las variables puestas en `.env.pre` (no se versiona; mismos nombres que en
   el `.env`: `DATABASE_URL` con el rol `stock_app` y el pooler de sesión, `DATABASE_MIGRATION_URL`, `AUTH_ISSUER`,
   `AUTH_JWKS_URL`), corre `npm run verify:pre`. Comprueba la dirección y el rol, el esquema y las migraciones, la
   seguridad por fila, que la Data API de Supabase no pueda leer nada, que el historial no se pueda cambiar, que las
   transacciones de la aplicación funcionen a través del pooler y que el proyecto publique claves de firma asimétricas.
   **Imprime un informe y ningún secreto:** puedes pegar la salida completa en el chat. Sale con 0 solo si todo pasa
   (ADR 0025).
5. **Crear el servicio de la API** con la imagen del backend y fijar sus variables (`PORT`, `CORS_ORIGINS`
   con la dirección del frontend de PRE, `DATABASE_URL` y, cuando existan, las de identidad). La comprobación
   de salud del host debe apuntar a `GET /health`. _Comprobar:_ `GET /health` responde `200` y un JSON con
   `status` en «ok»; y `GET /v1/ready` responde `200` con `database` en «up» (con `503` es que la base no responde
   o falta `DATABASE_URL`).
6. **Crear el sitio de la web** compilando con `VITE_API_URL` apuntando a la API de PRE. Todas las rutas deben
   devolver `index.html` (es una aplicación de una sola página). _Comprobar:_ abre la web: el panel «Estado del
   servicio» dice «En línea».
7. **Comprobar el CORS desde el navegador:** si el panel dice «Sin conexión» con la API en pie, la consola dice
   «blocked by CORS policy» y falta o sobra algo en `CORS_ORIGINS`.
8. **Pasar Lighthouse** sobre la dirección de PRE (accesibilidad 100).
9. **Anotar** en este documento las direcciones y quién opera cada panel.

**Si algo sale mal en PRE:** vuelve a publicar la imagen o la compilación anterior desde el panel del host. Una
migración **no** se revierte sola; por eso se aplica con cuidado y a mano.

### Estado de PRE

- **Proyecto de Supabase:** creado por Samuel. La aplicación se conecta por el pooler de sesión (puerto 5432) con el rol
  `stock_app`; el rol `postgres` solo se usa para migrar.
- **Migraciones:** las 7 están aplicadas. Las dos primeras, el 2026-10-18 por Diego con `npm run db:migrate` (20 tablas); la
  última, `20261023130000_folio_de_anulaciones` (C4-A1), el 2026-10-25, también por Diego (ver «Si algo sale mal» abajo: el primer
  intento había fallado). Las nuevas se aplican con el mismo script de siempre y **antes** de desplegar el código que las usa.
- **`npm run verify:pre`: 2026-10-25, Diego, 9 pasan, 0 fallan, 0 omitidas**, con las 7 migraciones. La primera corrida contra
  el Supabase real fue el 2026-10-18 (también 9 de 9, ADR 0025).
- **Lo que dejó comprobado:** el adaptador de Prisma funciona a través del pooler (25 transacciones sin que el negocio de
  una se filtre a otra); la seguridad por fila está forzada y sin decir de qué negocio se pregunta no se ve nada; `anon`,
  `authenticated` y `service_role` no tienen privilegios sobre las tablas; la aplicación no puede cambiar ni borrar el
  historial; y el proyecto firma con una clave asimétrica (ES256).
- **El recorrido con personas reales: 2026-10-18, Diego, las 24 filas dieron lo esperado** contra el Supabase de PRE, con la
  API y la web corriendo en su máquina (crear cuenta, abrir un negocio, catálogo, ajustes, compras, invitar y canjear
  como cajero, y los límites del cajero). Es la primera vez que la API verifica tokens reales de Supabase. El detalle está en
  el [historial de corridas](https://github.com/diegoandresvillarrealcastillo-maker/vsd-stock-frontend/blob/desarrollo/docs/recorrido-del-ciclo-2.md#historial-de-corridas)
  del frontend.
- **Los hosts (2026-10-25):** la API en Render (`https://vsd-stock-api-pre.onrender.com`) sigue la rama `preproduccion` y se
  redespliega sola; la web en Cloudflare Pages (`https://vsd-stock-pre.pages.dev`) se subió a mano desde `preproduccion` (commit
  `8e25260`, la promoción del frontend #92) con `wrangler pages deploy`, porque no hay despliegue automático.
  `npm run verify:deploy`: **14 pasan, 0 fallan, 0 omitidas**.
- **Lo que sigue sin comprobarse:** que el token se renueve solo (vence a la hora y el recorrido dura menos), el correo de
  confirmación y los límites de uso (en PRE «Confirm email» está apagado a propósito), y un teléfono real (C3-16: instalar la
  aplicación en el Android, abrirla en modo avión y vender; queda para antes de producción).

`verify:pre` se vuelve a correr cuando cambie el esquema, el proyecto o la documentación de Supabase en la que se apoya.
Dos cosas que se aprendieron en esta primera corrida:

- **Un `P1001` («no puedo llegar a la base») con el servidor del pooler respondiendo no es una contraseña mala:** una
  contraseña mala da `P1000` (se comprobó contra este mismo pooler). En la primera corrida el `P1001` salió justo después
  de cambiar la contraseña del rol `postgres` y se resolvió esperando unos minutos y repitiendo; la causa exacta no se
  confirmó (una base que se reinicia es la explicación más probable). Si se repite, se mira que el proyecto diga
  _Healthy_ y no _Paused_.
- **El host del pooler no es el mismo en todos los proyectos** (`aws-0-…` o `aws-1-…`, y la región). Se copia del botón
  _Connect_ del proyecto; con uno equivocado, Supabase responde que no encuentra el tenant o el usuario.

## Crear los hosts de PRE

La API corre en **Render** y la web en **Cloudflare Pages**, los dos con su plan gratuito y los dos por **HTTPS** (sin HTTPS no hay
service worker, ni cifrado en el equipo, ni cámara en un teléfono). Por qué esos y lo que cuestan está en el
[ADR 0031](adr/0031-hosts-de-pre-render-y-cloudflare-pages.md). **Lo hace una persona**, en los paneles: el asistente de código solo
deja escrito qué hacer (`render.yaml` y esta guía) y cómo comprobarlo (`npm run verify:deploy`).

> **Los secretos no se pegan en ningún chat.** Cada valor que sigue se escribe **en el panel**, donde se guarda. Si algo falla, pega
> lo que dice el informe de `verify:deploy` (no lleva secretos) o el mensaje de error **sin** la cadena de conexión.

### Antes de empezar

1. **El Supabase de PRE está listo** ([Estado de PRE](#estado-de-pre)): tienes su dirección (`https://TU-REF.supabase.co`) y la
   cadena de conexión del rol `stock_app` en tu gestor de contraseñas.
2. **Las migraciones del Ciclo 3 ya se aplicaron** (`20261018120000_turnos`, `20261019120000_ventas`,
   `20261020120000_revision_de_ventas`): con `npm run db:migrate`, **antes** de desplegar el código que las usa.
3. **La rama `preproduccion` tiene el código que quieres probar.** Llega ahí con una promoción `desarrollo → preproduccion`, que solo
   se abre **con el visto bueno del dueño del proyecto** (ver [Promover entre ambientes](#promover-entre-ambientes)). Mientras no
   exista, no hay nada que desplegar: `render.yaml` y la web miran solo esa rama a propósito.

### La API en Render

1. Entra a [render.com](https://render.com) con tu cuenta de GitHub. No pide tarjeta para el plan gratuito.
2. **New → Blueprint.** Conecta el repositorio `vsd-stock-backend` y elige la rama `preproduccion`. Render lee `render.yaml` y
   muestra el servicio `vsd-stock-api-pre` (Docker, plan _Free_, región _Virginia_).
3. Render te pide **cuatro valores** (los que `render.yaml` marca con `sync: false`; no están en el archivo a propósito):

   | Variable        | Qué poner                                                                                                                    | De dónde sale                             |
   | --------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
   | `DATABASE_URL`  | La conexión del rol **`stock_app`** por el **pooler de sesión** (puerto 5432), con el usuario `stock_app.TU-REF`.            | Tu gestor de contraseñas o tu `.env.pre`. |
   | `CORS_ORIGINS`  | La dirección **exacta** de la web de PRE, sin barra final: `https://vsd-stock-pre.pages.dev`. Si aún no existe, escribe esa. | La web de PRE (más abajo).                |
   | `AUTH_ISSUER`   | `https://TU-REF.supabase.co/auth/v1`                                                                                         | El proyecto de Supabase.                  |
   | `AUTH_JWKS_URL` | `https://TU-REF.supabase.co/auth/v1/.well-known/jwks.json`                                                                   | El proyecto de Supabase.                  |

   `AUTH_AUDIENCE` ya viene escrita (`authenticated`) y el puerto lo da Render. **Nunca** pongas aquí `DATABASE_MIGRATION_URL`: es la
   conexión del dueño de las tablas y solo se usa a mano desde tu máquina.

4. **Apply.** El primer despliegue construye la imagen y tarda unos 5 a 8 minutos. La API queda en
   `https://vsd-stock-api-pre.onrender.com` (o con otro sufijo si ese nombre estaba tomado: Render lo muestra arriba del servicio).
5. _Comprobar:_ abre `https://vsd-stock-api-pre.onrender.com/health` en el navegador: debe mostrar un JSON con `status` en «ok».

### La web en Cloudflare Pages

1. Entra a [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create → Pages → Connect to Git** y elige
   `vsd-stock-frontend`. La **rama de producción** del proyecto es `preproduccion`. Nómbralo `vsd-stock-pre`.
2. En la configuración de la compilación:

   | Campo                  | Valor           |
   | ---------------------- | --------------- |
   | Framework preset       | _None_          |
   | Build command          | `npm run build` |
   | Build output directory | `dist`          |

3. En **Environment variables** (de _Production_), estas cuatro. Todo lo que lleva el prefijo `VITE_` termina en el paquete que
   descarga cualquier persona: nunca un secreto.

   | Variable                    | Valor                                                               |
   | --------------------------- | ------------------------------------------------------------------- |
   | `NODE_VERSION`              | `24`                                                                |
   | `VITE_API_URL`              | La dirección de la API de PRE, sin barra final.                     |
   | `VITE_AUTH_URL`             | `https://TU-REF.supabase.co/auth/v1`                                |
   | `VITE_AUTH_PUBLISHABLE_KEY` | La clave **publicable** (`sb_publishable_…`). **Nunca** la secreta. |

4. **Save and Deploy.** La web queda en `https://vsd-stock-pre.pages.dev`. Si Cloudflare le puso otro nombre, **esa** es la
   dirección que va en `CORS_ORIGINS`.
5. Las reglas de caché del service worker y de los archivos viajan en el repositorio del frontend (`public/_headers`): no hay nada
   que configurar a mano. Cloudflare Pages sirve la aplicación desde cualquier ruta cuando el sitio no trae un `404.html` propio.

### Conectarlas

Si al crear la API pusiste una dirección provisional en `CORS_ORIGINS`, corrígela ahora con la dirección **real** de la web
(Render → _Environment_). Render vuelve a desplegar solo. Una dirección con una barra final o con otro puerto **no** coincide: el
navegador dirá «blocked by CORS policy».

### Comprobarlos

Desde tu máquina, con el repositorio del backend:

```bash
npm run verify:deploy -- https://vsd-stock-api-pre.onrender.com https://vsd-stock-pre.pages.dev
```

(Con tus direcciones.) Hace unas diez peticiones a esos dos hosts y nada más: no toca ninguna base ni pide ninguna clave. Comprueba que
las direcciones sean HTTPS; que la API responda en `/health`, **cuánto tardó en despertar** y que siga rápida una vez despierta; que
llegue a su base (`/v1/ready`); que rechace una llamada sin sesión; que le dé permiso **solo** a la web de PRE y a nadie más; y que la web
sirva la aplicación, la recargue desde cualquier ruta, publique el manifiesto y el service worker (sin caché larga, para que una versión
nueva se encuentre) y guarde un año los archivos con huella. **Imprime un informe y ningún secreto: puedes pegarlo completo en el
chat.** Sale con `0` solo si todo pasó. La primera vez, la API suele estar dormida: la comprobación `wake` dice cuánto tardó.

Después, **abre la web en un teléfono**: el panel «Estado del servicio» debe decir «En línea» y la aplicación debe poder instalarse.
Eso, con las mediciones, es C3-16.

### Lo que cuesta el plan gratuito

Verificado el 2026-10-19 en la documentación de cada host (el [ADR 0031](adr/0031-hosts-de-pre-render-y-cloudflare-pages.md) lo
explica y dice por qué se acepta en PRE):

- **La API se duerme a los 15 minutos sin tráfico** y tarda alrededor de **un minuto** en despertar: mientras tanto el navegador ve
  una página de carga y el panel «Estado del servicio» puede decir «Sin conexión». **No pierde nada:** lo que se hizo sin conexión
  espera en el equipo y se envía cuando la API contesta. Hay **750 horas de instancia por mes** (una API despierta todo el mes cabe
  en ellas) y si se acaban, el servicio se suspende hasta el mes siguiente.
- **Sin disco persistente, sin escalar más allá de una instancia, sin caché de borde, sin correo saliente** (los puertos 25, 465 y
  587 están bloqueados). La API no guarda nada en disco ni manda correos, así que nada de esto la afecta.
- **Cloudflare Pages:** 500 compilaciones por mes, 20.000 archivos por sitio y 25 MiB por archivo. Sobra.

### Si algo sale mal

- **Render:** _Events → Rollback_ al despliegue anterior, o _Manual Deploy_ de otra rama. Una migración **no** se revierte sola.
- **Cloudflare Pages:** _Deployments_ → el despliegue anterior → _Rollback to this deployment_.
- **`/v1/ready` responde 503:** la API no llega a su base. Revisa `DATABASE_URL` (el rol `stock_app`, el pooler de sesión y el puerto 5432) y que el proyecto de Supabase diga _Healthy_.
  Justo después de fusionar a `preproduccion` también pasa mientras Render reinicia la API (2026-10-25): se espera unos minutos y se repite `verify:deploy`.
- **El navegador dice «blocked by CORS policy»:** `CORS_ORIGINS` no es la dirección exacta de la web.
- **`P3009` («migrate found failed migrations»):** un intento anterior de una migración falló y Prisma no aplica ninguna más hasta
  que se marque. La causa está en la columna `logs` de la fila de `_prisma_migrations` que tiene `finished_at` vacío. Como cada
  migración corre en una sola transacción, un fallo no deja nada a medias (se comprueba mirando la tabla). Entonces se marca con
  `npx prisma migrate resolve --rolled-back NOMBRE_DE_LA_MIGRACION` y se repite `npm run db:migrate`. Pasó el 2026-10-25 con
  `20261023130000_folio_de_anulaciones` (`relation "void_counter" already exists`): un borrador descartado, sin rastrear en el clon,
  se había aplicado antes. **Antes de migrar, `git status` debe estar limpio: sin migraciones sin rastrear.**
- **`db:migrate` lee `.env`, no `.env.pre`** (ese lo lee `verify:pre`): lo que importa es a qué base apunta `DATABASE_MIGRATION_URL` en
  el `.env` de quien migra. El script imprime «Las migraciones se aplicarán a:» y, si la base no es de esa máquina, pide escribir el
  host: se lee antes de confirmar.
- **La prueba «Transacciones a través del pooler» falla con `Unable to start a transaction in the given time`:** Prisma espera 2
  segundos por una conexión (ADR 0013) y el pooler tardó más. Fue pasajero (2026-10-25: falló dos veces y pasó después sin tocar
  nada). Se repite; si persiste, se mira que Supabase diga _Healthy_ y cuántas conexiones tiene abiertas.

## Promover entre ambientes

- `desarrollo → preproduccion` y `preproduccion → produccion` son Pull Requests como cualquier otro, pero solo
  se abren **con el visto bueno del dueño del proyecto**. Nunca se borra `desarrollo`.
- Una promoción trae commits que ya se revisaron al entrar a `desarrollo`; por eso el CI no vuelve a
  validar su convención de commits (los rechazaría sin poder corregirlos).
- El backend se promueve **antes** que el frontend que depende de él.
- Hoy la promoción a `produccion` **no se hace** (PROD en pausa).

## Pasos manuales de GitHub

La protección de ramas y los checks exigidos se configuran en el panel del repositorio. Están en la
[guía de GitHub](guia-github.md#conjunto-de-reglas-y-checks-exigidos), con los nombres exactos de los checks.
