# Crear producción (PROD)

El paso a paso para que una persona cree producción de verdad: la base de datos, las siete migraciones, la API, la web de la aplicación y la
landing. **Hoy PROD no existe y sigue en pausa** ([`ambientes.md`](ambientes.md#prod-en-pausa)). Este documento no levanta la pausa: dice qué hay que
decidir antes, y qué comandos y variables se usan cuando el dueño del proyecto la levante por escrito.

> **Quién hace qué.** El asistente de código no opera paneles externos ni aplica migraciones: nunca Claude. Lo hace una persona, siguiendo esta
> lista. Es la misma que se siguió para PRE ([ADR 0031](adr/0031-hosts-de-pre-render-y-cloudflare-pages.md); una persona que no es de
> infraestructura lo hizo en una tarde), con las diferencias de abajo.
>
> **Los secretos no se pegan en ningún chat**: cada valor se escribe en el panel donde se guarda o en tu `.env`, nunca en un chat, un ticket, un
> PR ni un archivo del repositorio. Los informes de `verify:pre` y `verify:deploy` no llevan secretos y sí se pueden pegar.

## De un vistazo

| Paso | Qué                                                         | Dónde                     | Se comprueba con                       |
| ---- | ----------------------------------------------------------- | ------------------------- | -------------------------------------- |
| 0    | Decidir y levantar la pausa, por escrito                    | El dueño del proyecto     | El ADR de PROD, aceptado               |
| 1    | Promover el código a `produccion`                           | GitHub                    | Los dos PR fusionados, backend primero |
| 2    | Crear la base `vsd-stock-prod`                              | Supabase                  | El proyecto en _Healthy_               |
| 3    | Aplicar las 7 migraciones                                   | Tu terminal (una persona) | `npm run db:migrate` termina bien      |
| 4    | Verificar la base                                           | Tu terminal               | 9 comprobaciones que pasan             |
| 5    | Crear la API                                                | Render                    | `/health` y `/v1/ready`                |
| 6    | Publicar la web de la aplicación                            | Cloudflare Pages          | La web abre y dice «En línea»          |
| 7    | Conectar las dos y comprobarlas                             | Render y tu terminal      | `npm run verify:deploy`                |
| 8    | Publicar la landing (`--produccion`)                        | Cloudflare Pages          | `npm run verify:sitio`                 |
| 9    | Recorrer una venta completa y el teléfono, ya en producción | Un teléfono               | Venta, anulación y reporte             |

## 0. Antes de tocar nada

Mientras no se diga lo contrario, no se crea nada de PROD: ni el proyecto de Supabase, ni el servicio de la API, ni el sitio de la web, ni las
variables, ni el dominio. Quien levanta la pausa es el dueño del proyecto, **por escrito**, y lo primero que se escribe es un ADR con lo que hay que
tener resuelto:

1. **Copias de seguridad.** Qué copias trae el plan de Supabase que se elija, cada cuánto, y una restauración de prueba **antes** de recibir un solo dato
   real. Una migración no se revierte sola (ver «Si algo sale mal»): la copia es la única vuelta atrás de los datos.
2. **Quién atiende un incidente**, con nombre y con cómo se le avisa. Hoy no hay monitoreo continuo.
3. **Qué pasa con los datos de los negocios**: quién puede verlos en el panel de Supabase, cuánto tiempo se guardan y cómo se borra una cuenta.
4. **Quién corre las migraciones en producción.** Una persona con nombre, nunca Claude. Conviene que otra persona esté presente o revise el informe.
5. **Los planes, y su costo.** El precio vigente se mira en cada panel; aquí no se copia de memoria.
   - **Render:** el plan gratuito duerme la API tras 15 minutos sin tráfico y tarda cerca de un minuto en despertarla. El
     [ADR 0031](adr/0031-hosts-de-pre-render-y-cloudflare-pages.md) dijo que en PROD eso no es aceptable: la API de producción necesita una instancia de
     pago que no se duerma.
   - **Supabase:** el plan gratuito permite dos proyectos activos y, según el ADR 0031, el proyecto de PRE ya consume los dos. Crear `vsd-stock-prod` puede pedir
     pasar a un plan de pago o liberar uno. Lo que cada plan incluye de copias de seguridad se mira en el panel antes de elegir.
   - **Cloudflare Pages:** el plan gratuito sirve (500 compilaciones al mes, 20.000 archivos por sitio).
6. **El correo de confirmación de Supabase.** En PRE «Confirm email» está apagado a propósito y **nunca se probó el correo real**, ni los límites de uso.
   En PROD hay que decidir si va encendido y con qué remitente; si va encendido, se prueba antes de abrir la puerta.
7. **El límite de intentos de canje de invitaciones.** El [ADR 0023](adr/0023-negocio-personas-e-invitaciones.md) dejó escrito que la API no limita
   los intentos y que el límite de tasa por IP «queda para antes de producción». **No está hecho.** Se construye antes, o el dueño acepta por escrito
   salir sin él.
8. **La prueba en un Android real** (Diego y Samuel, ticket frontend #37 y #39 y backend #64). Decisión del 25 de octubre de 2026: no bloqueó llevar el ciclo
   a PRE y **sí** es requisito antes de producción. Conviene hacerla sobre el mismo código que va a salir: ver el paso 1.

Lo que **no** es requisito, por decisión de Diego del 25 de octubre de 2026: la lectura en voz alta con un tendero, el aviso legal de WhatsApp y la validación
del reporte mensual por el contador. Quedan en el backlog (épica [ONB-0 del frontend](https://github.com/diegoandresvillarrealcastillo-maker/vsd-stock-frontend/issues/99)).

## 1. Promover el código a `produccion`

`produccion` sigue en su commit inicial (2026-10-16): la primera promoción trae todo lo que hay en `preproduccion`. Las promociones son Pull Requests que solo
se abren con el visto bueno del dueño; el backend va **antes** que el frontend ([Promover entre ambientes](ambientes.md#promover-entre-ambientes)). Quien abre el
PR no lo aprueba ni lo fusiona; Samuel fusiona con _Create a merge commit_.

1. **Si `desarrollo` tiene algo que `preproduccion` no** (a 25 de octubre: en el frontend, el aviso del reporte mensual (C4-Q2) y la
   explicación de exento y excluido (C4-Q3); en el backend, solo documentación), promuévelo primero a PRE, redespliega PRE y haz la prueba del Android sobre eso.
   La API de PRE se redespliega sola; la web de PRE se sube a mano ([`despliegue-de-la-web.md`](https://github.com/diegoandresvillarrealcastillo-maker/vsd-stock-frontend/blob/desarrollo/docs/despliegue-de-la-web.md)).
2. Con el visto bueno por escrito: PR `preproduccion → produccion` en `vsd-stock-backend`, y cuando esté fusionado, el de `vsd-stock-frontend`.

   ```bash
   gh pr create --repo diegoandresvillarrealcastillo-maker/vsd-stock-backend --base produccion --head preproduccion \
     --title "chore(release): promovemos preproduccion a produccion"
   ```

   (O el botón _New pull request_ de GitHub, con base `produccion` y comparando con `preproduccion`.) Una promoción trae commits que ya se revisaron, por eso el
   CI no vuelve a validar su convención de commits.

## 2. La base de datos: Supabase `vsd-stock-prod`

Un proyecto de Supabase **aparte** del de PRE. Nada de la base de PRE se reutiliza.

1. **New project.** Nombre `vsd-stock-prod`. Región: la más cercana a la API (PRE usa AWS us-east-1, Virginia, igual que Render): no se puede cambiar después.
   La contraseña de la base va a tu gestor de contraseñas, no a un archivo ni a un chat.
2. **De _Connect_ copia** la referencia del proyecto y el host del **pooler de sesión** (puerto **5432**, no el 6543). El host no es el mismo en todos los
   proyectos (`aws-0-…` o `aws-1-…`): se copia del botón, no de este documento. _Comprobar:_ el proyecto dice _Healthy_.
3. **Apaga la Data API** (_Integrations → Data API_). La migración le quita los permisos a `anon`, `authenticated` y `service_role` por si se enciende, pero es una
   instrucción para una persona ([ADR 0021](adr/0021-esquema-real-y-primera-migracion.md)).
4. **Crea el rol de la aplicación.** En el _SQL Editor_, con una contraseña propia de 32 letras y números que solo vive en tu gestor de contraseñas. Borra después la
   consulta guardada, porque lleva la contraseña:

   ```sql
   create role stock_app login password 'PEGA_AQUI_LA_CONTRASENA'
     nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
   grant usage on schema public to stock_app;
   ```

5. **Claves de firma asimétricas.** La API verifica los tokens con las claves públicas del proyecto (`AUTH_JWKS_URL`). Si el proyecto firma todavía con el secreto
   compartido, esa lista viene vacía y la comprobación 9 del paso 4 falla; se cambia en los ajustes de claves JWT del proyecto (los nombres del panel cambian: busca
   _JWT signing keys_). PRE firma con ES256.
6. **Autenticación.** Fija la decisión del correo de confirmación (paso 0, punto 6) y, cuando exista la dirección de la web (paso 6), pon esa dirección como _Site URL_.

## 3. Las 7 migraciones (una persona)

En una **copia limpia y aparte** del backend, no en la que usas para PRE: `db:migrate` lee `.env` y ese `.env` apunta a una sola base.

```powershell
git clone https://github.com/diegoandresvillarrealcastillo-maker/vsd-stock-backend.git vsd-stock-prod-migracion
cd vsd-stock-prod-migracion
git switch produccion
git status                          # debe decir: nothing to commit, working tree clean
Get-ChildItem prisma/migrations     # siete carpetas y migration_lock.toml; si hay otra cosa, detente
npm ci
```

Crea el archivo `.env` con un editor de texto (no con `echo`: la contraseña quedaría en el historial de la terminal) y **una sola línea**:

```text
DATABASE_MIGRATION_URL=postgresql://postgres.REF_DE_PROD:CONTRASENA_DEL_DUENO@HOST_DEL_POOLER:5432/postgres
```

`DATABASE_MIGRATION_URL` es la conexión del dueño de las tablas (el rol `postgres` del proyecto) y nunca se le da a la API ni a Render: solo migra, a mano, desde tu máquina.

```powershell
npm run db:migrate
```

El comando muestra a qué base apunta (sin la contraseña) y **pide escribir el host** para confirmar: léelo antes de escribirlo. Si no es el de `vsd-stock-prod`, Enter
vacío cancela. Termina con «Migraciones aplicadas.», y aplicó, en este orden:

1. `20261017120000_modelo_inicial`
2. `20261017130000_invitaciones`
3. `20261018120000_turnos`
4. `20261019120000_ventas`
5. `20261020120000_revision_de_ventas`
6. `20261023120000_tipo_tributario`
7. `20261023130000_folio_de_anulaciones`

- **Una migración aplicada no se edita** (el ajuste va en una nueva) y `prisma migrate reset` está prohibido.
- **La última apaga un disparador un momento.** `20261023130000_folio_de_anulaciones` desactiva `refuse_history_change` y la seguridad por fila forzada de
  `sale_void` mientras numera lo que ya existe, y los vuelve a poner antes de terminar, en la misma transacción. En una base nueva no hay nada que numerar, pero
  igual se comprueba al final, en el _SQL Editor_ (el disparador debe estar activo, `O`, y las dos tablas con la seguridad por fila forzada):

  ```sql
  select tgname, tgenabled from pg_trigger
    where tgrelid = '"sale_void"'::regclass and not tgisinternal;
  select relname, relrowsecurity, relforcerowsecurity from pg_class
    where relname in ('sale_void', 'void_counter');
  ```

- **`P3009`** (una migración falló antes): no sigas aplicando. La receta está en [`ambientes.md`](ambientes.md#si-algo-sale-mal). Antes de migrar, `git status` limpio.
- Después, **borra el `.env`** de esa copia o la carpeta entera: no lo dejes con la contraseña del dueño.

## 4. Verificar la base

`verify:pre` comprueba la base y el servicio de identidad reales ([ADR 0025](adr/0025-verificacion-de-pre-contra-supabase.md)). Sirve igual contra PROD, **aunque el
informe se titule «Verificación de PRE»** (los scripts se escribieron para PRE y no se renombraron). Crea `.env.prod` en la misma copia (los archivos `.env.*` no se suben):

```text
DATABASE_URL=postgresql://stock_app.REF_DE_PROD:CONTRASENA_DE_LA_APP@HOST_DEL_POOLER:5432/postgres
DATABASE_MIGRATION_URL=postgresql://postgres.REF_DE_PROD:CONTRASENA_DEL_DUENO@HOST_DEL_POOLER:5432/postgres
AUTH_ISSUER=https://REF_DE_PROD.supabase.co/auth/v1
AUTH_JWKS_URL=https://REF_DE_PROD.supabase.co/auth/v1/.well-known/jwks.json
AUTH_AUDIENCE=authenticated
```

```powershell
npm run build
node --env-file=.env.prod scripts/verify-pre.ts
```

(No se usa `npm run verify:pre` porque ese lee `.env.pre`.) _Comprobar:_ **9 pasan, 0 fallan, 0 omitidas**, con las 7 migraciones. Imprime un informe y ningún
secreto: pégalo completo en el chat. Si falla una, no sigas.

## 5. La API en Render

`render.yaml` describe solo PRE (`vsd-stock-api-pre`, rama `preproduccion`). **No se le suma un segundo servicio todavía**: el Blueprint de PRE lee ese archivo
y un servicio nuevo ahí se crearía o se ofrecería desde PRE. Se decide en el ADR de PROD. Mientras tanto, el servicio se crea a mano, con los mismos valores:

1. [render.com](https://render.com) → **New → Web Service**, desde el repositorio `vsd-stock-backend`.
2. Ajustes (los nombres de los campos pueden haber cambiado; el sentido es el de `render.yaml`, verificado en la guía de PRE el 2026-10-19; **no pude abrir el panel
   de Render para confirmarlos hoy**):

   | Campo             | Valor                                                                    |
   | ----------------- | ------------------------------------------------------------------------ |
   | Nombre            | `vsd-stock-api`                                                          |
   | Rama              | `produccion`                                                             |
   | Runtime           | Docker (`./Dockerfile`, contexto `.`)                                    |
   | Región            | Virginia                                                                 |
   | Plan              | De pago, **que no se duerma** (paso 0, punto 5)                          |
   | Health Check Path | `/health`                                                                |
   | Despliegue        | Al hacer commit en `produccion` (solo cambia con una promoción aprobada) |

3. Variables de entorno. Las cuatro primeras se escriben **en el panel**; `AUTH_AUDIENCE` y el puerto no son secretos y el puerto lo da Render:

   | Variable        | Qué poner                                                                                                   |
   | --------------- | ----------------------------------------------------------------------------------------------------------- |
   | `DATABASE_URL`  | La conexión del rol **`stock_app`** por el pooler de sesión (5432), usuario `stock_app.REF_DE_PROD`.        |
   | `CORS_ORIGINS`  | La dirección **exacta** de la web de PROD, sin barra final. Si aún no existe, una provisional (se corrige). |
   | `AUTH_ISSUER`   | `https://REF_DE_PROD.supabase.co/auth/v1`                                                                   |
   | `AUTH_JWKS_URL` | `https://REF_DE_PROD.supabase.co/auth/v1/.well-known/jwks.json`                                             |
   | `AUTH_AUDIENCE` | `authenticated`                                                                                             |

4. **Create.** El primer despliegue construye la imagen. _Comprobar:_ `https://TU-API-DE-PROD.onrender.com/health` muestra un JSON con `status` en «ok», y
   `/v1/ready` responde `200` con `database` en «up» (con `503`: revisa `DATABASE_URL`, el rol `stock_app`, el puerto 5432 y que Supabase diga _Healthy_).

## 6. La web de la aplicación en Cloudflare Pages

Es otro proyecto, distinto del de la landing y del de PRE. Con la **subida directa**, como en PRE (el asistente de Cloudflare ofrecía solo crear un Worker). En una copia
limpia del frontend, con Node 24:

```powershell
git clone https://github.com/diegoandresvillarrealcastillo-maker/vsd-stock-frontend.git vsd-stock-prod-web
cd vsd-stock-prod-web
git switch produccion
git status                          # limpio
npm ci
$env:VITE_API_URL = 'https://TU-API-DE-PROD.onrender.com'
$env:VITE_AUTH_URL = 'https://REF_DE_PROD.supabase.co/auth/v1'
$env:VITE_AUTH_PUBLISHABLE_KEY = 'sb_publishable_...'
npm run build
Remove-Item Env:VITE_API_URL, Env:VITE_AUTH_URL, Env:VITE_AUTH_PUBLISHABLE_KEY
npx wrangler login
npx wrangler pages project create vsd-stock-app --production-branch produccion --force
npx wrangler pages deploy dist --project-name vsd-stock-app --branch produccion --commit-dirty=true
```

- Las tres variables `VITE_` se fijan **al compilar**: todo lo que se compila lo descarga el navegador de cualquiera. Va la clave **publicable** (`sb_publishable_…`); la clave
  secreta del proyecto no va nunca, y la aplicación se niega a arrancar si encuentra una.
- `project create` solo se hace la primera vez. El nombre es el subdominio (`vsd-stock-app.pages.dev`, si está libre); un proyecto de Pages no se puede renombrar.
- **No uses `wrangler deploy`:** crea un Worker, no un proyecto de Pages. Y **no hay despliegue automático**: la web cambia cuando alguien repite `npm run build` y el `deploy`.
- Las reglas de caché del service worker viajan en `public/_headers`; no hay nada que configurar.
- Anota la dirección que imprime `deploy`: es la de `CORS_ORIGINS` y el _Site URL_ de Supabase.

## 7. Conectarlas y comprobarlas

1. En Render, pon en `CORS_ORIGINS` la dirección **exacta** de la web (sin barra final, sin ruta). Render redespliega solo. Una barra de más y el navegador dice
   «blocked by CORS policy».
2. Desde la copia del backend:

   ```bash
   npm run verify:deploy -- https://TU-API-DE-PROD.onrender.com https://TU-WEB-DE-PROD.pages.dev
   ```

   Hace unas diez peticiones y nada más; no toca la base ni pide claves. Los textos dicen «PRE» (se escribió para PRE), pero comprueba lo mismo: HTTPS, `/health`,
   `/v1/ready`, que rechace una llamada sin sesión, que el CORS dé permiso **solo** a esa web, y que la web sirva la aplicación desde cualquier ruta, el manifiesto y el
   service worker sin caché larga. Sale con 0 solo si todo pasó. Justo después de un despliegue puede dar `503` mientras Render reinicia: espera unos minutos y repite.

3. Cierra con el recorrido de producción, ya con la web real: crear la cuenta del dueño, abrir el negocio, un producto, abrir turno, una venta, anularla, el reporte del mes
   y cerrar el turno; y en un teléfono, instalar la aplicación, abrirla en modo avión y vender (la misma prueba del Android, ahora sobre producción). Los datos de esas pruebas son
   reales en cuanto se escriben: usa un negocio de prueba con un nombre que lo diga.

## 8. La landing (`--produccion`)

`--produccion` es la bandera de la landing, no de la aplicación: `npm run publish:sitio -- --produccion` publica `https://vsd-stock-sitio.pages.dev`, otro proyecto de Cloudflare Pages
(`vsd-stock-sitio`), desde `desarrollo` ya fusionado. La guía completa está en el frontend ([`sitio.md`](https://github.com/diegoandresvillarrealcastillo-maker/vsd-stock-frontend/blob/desarrollo/docs/sitio.md)).

```powershell
git switch desarrollo; git pull --ff-only
npm ci
npm run publish:sitio -- --produccion --simular     # dice si se puede y con qué comando, sin subir nada
npm run publish:sitio -- --produccion
npm run build:sitio
npm run verify:sitio -- https://vsd-stock-sitio.pages.dev
```

- Se **niega** mientras quede algo en `PENDIENTES_DE_PUBLICAR` (`sitio/pagina/pendientes.ts`), con todas las razones juntas. Desde el 25 de octubre de 2026 queda uno: actualizar la respuesta
  sobre teléfonos con el resultado de la prueba del Android real (Samuel). Quien lo resuelve lo quita en un PR.
- Web Analytics debe seguir apagado en el panel del proyecto, o la comprobación 9 falla.
- La landing sigue apuntando a la demo de **PRE** (la política de contenido solo deja conectarse al sitio y a la API de PRE): publicar PROD no la cambia.

## 9. Si algo sale mal

- **Render:** _Events → Rollback_ al despliegue anterior, o _Manual Deploy_ de otra rama. **Cloudflare Pages:** _Deployments_ → el anterior → _Rollback to this deployment_.
- **Una migración no se revierte sola.** Arreglar una migración mala es otra migración, y lo que ya se escribió en una base real solo vuelve con una copia de seguridad (paso 0, punto 1).
- `503` en `/v1/ready`, «blocked by CORS policy» y `P3009` tienen su receta en [`ambientes.md`](ambientes.md#si-algo-sale-mal).
- Una clave pegada por error se considera comprometida: se rota en su panel, no se «borra del historial».

## Lo que este manual no cubre

- **Los scripts dicen «PRE»**: `verify:pre` y `verify:deploy` (y sus informes) se escribieron para PRE. Funcionan contra PROD con las variables de arriba; renombrarlos o parametrizar el
  título es una mejora pendiente.
- **Monitoreo, alertas y un procedimiento de restauración escrito**: no existen. Son parte del ADR de PROD.
- **Dominio propio** (cambia `CORS_ORIGINS`, el _Site URL_ de Supabase y obliga a volver a correr `verify:deploy`), **Content-Security-Policy de la web** (hoy no tiene; está anotada como mejora
  en `despliegue-de-la-web.md`) y **correo saliente** (Render bloquea los puertos 25, 465 y 587; la API no manda correos).
- **Lo que no se probó en PRE y llegaría sin probar:** que el token se renueve solo, el correo de confirmación y los límites de uso.
