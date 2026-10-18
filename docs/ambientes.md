# Plan de ambientes

Dónde corre VSD Stock, qué hay hoy, qué falta, y los pasos manuales que le tocan a la persona que opera los
paneles (GitHub, Supabase y los hosts). **PROD está en pausa.**

> **Quién hace qué.** El asistente de código **no opera paneles externos** ni aplica migraciones: escribe lo que
> hace falta y dice **exactamente** qué hacer, paso a paso. Lo hace una persona. Este documento es esa lista.

## Los ambientes

| Ambiente  | Rama               | Para qué                                                  | Dónde corre                                                              | Datos                      | Estado                        |
| --------- | ------------------ | --------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------- | ----------------------------- |
| **Local** | tu rama de trabajo | Desarrollar y probar en tu equipo.                        | Tu máquina: la API en `localhost:3000`, el frontend en `localhost:5173`. | Base de trabajo en Docker. | **Disponible**                |
| **DEV**   | `desarrollo`       | Integrar. Es la rama donde entra todo lo revisado.        | No tiene servidor: la verifica el CI de GitHub en cada PR y cada push.   | Base desechable del CI.    | **Disponible**                |
| **PRE**   | `preproduccion`    | Probar con el equipo, con datos ficticios, antes de PROD. | Un proyecto de Supabase, un host para la API y un host para la web.      | Ficticios.                 | **Por crear** (ver más abajo) |
| **PROD**  | `produccion`       | Lo que usan los negocios de verdad.                       | Igual que PRE, aparte.                                                   | Reales.                    | **En pausa**                  |

La cadena es `tu rama → desarrollo → preproduccion → produccion` (ADR 0010). La rama por defecto de los dos
repositorios es `produccion`, así que cada PR indica su base de forma explícita: `--base desarrollo`.

### PROD en pausa

Mientras no se diga lo contrario **no se configura, no se promueve y no se prueba contra ella**: ni el proyecto
de Supabase, ni el host de la API, ni el de la web, ni las variables, ni el dominio. Quien levante la pausa es
el dueño del proyecto, por escrito. Se propone que lo primero sea un ADR con lo que hay que preparar (copias de
seguridad, quién atiende un incidente, qué pasa con los datos de los negocios).

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

## Variables de entorno

Cada ambiente configura estas variables **en su propio panel**, nunca en el repositorio. Quien añada una
variable nueva la documenta aquí y en el README en el mismo PR (una prueba lo comprueba para las del
`.env.example` del backend).

| Variable                 | Repositorio | Cuándo se fija  | Qué es                                                                                                                                                                                   | Local                                    | PRE                                                                                              |
| ------------------------ | ----------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `PORT`                   | backend     | Al arrancar     | Puerto en el que escucha la API.                                                                                                                                                         | `3000`                                   | El que dé el host.                                                                               |
| `CORS_ORIGINS`           | backend     | Al arrancar     | Orígenes, separados por comas, a los que se les permite leer las respuestas desde un navegador.                                                                                          | `http://localhost:5173`                  | La dirección **exacta** del frontend de PRE, sin barra final.                                    |
| `VITE_API_URL`           | frontend    | **Al compilar** | Dirección de la API. Todo lo que lleva el prefijo `VITE_` llega al navegador: nunca un secreto.                                                                                          | `http://localhost:3000`                  | La dirección de la API de PRE.                                                                   |
| `DATABASE_MIGRATION_URL` | backend     | Al migrar       | Conexión del rol **dueño** de las tablas, solo para `npm run db:migrate` y el CLI de Prisma. La API no la lee. Lleva contraseña: va en tu `.env`, nunca en un chat ni en el repositorio. | No hace falta: usa `npm run db:prepare`. | La conexión del rol `postgres` por el **pooler de sesión** (puerto 5432); la aplica una persona. |

**Todavía no existen** (llegan con el ticket que las necesita, cada una con su ADR y su lugar en esta tabla): la
cadena de conexión de la **aplicación** a la base de datos (`DATABASE_URL`, rol `stock_app`, ticket C2-02) y las de
la verificación de identidad (`AUTH_ISSUER`, `AUTH_JWKS_URL` y `AUTH_AUDIENCE`, ticket C2-03).

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

Es la lista para quien opera los paneles. **Todavía no se hace:** el backend no necesita una base de datos hasta
el Ciclo 2, y ahí es donde PRE se vuelve necesario. Esta lista no elige hosts: **dónde se despliega es un ADR
del ciclo que prepare PRE** (ADR 0011). Cada punto dice qué hacer y qué comprobar después.

1. **Decidir los hosts.** Un host para la API (corre la imagen de Docker del backend, ADR 0011) y uno para la
   web (sirve `dist/`). Se escribe como ADR y se aprueba antes de crear nada.
2. **Crear el proyecto de Supabase de PRE**, aparte del de cualquier otro ambiente. Anota dónde guardas su
   contraseña (un gestor de contraseñas, no un archivo). _Comprobar:_ conecta con el **pooler**; en la versión
   anterior de VSD Stock el host directo solo publicaba IPv6 y no resolvía desde algunas redes, así que
   confírmalo al crearlo. El ADR 0005 permite el pooler en modo transacción.
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
5. **Crear el servicio de la API** con la imagen del backend y fijar sus variables (`PORT`, `CORS_ORIGINS`
   con la dirección del frontend de PRE y, cuando existan, las de base de datos y de identidad). La comprobación
   de salud del host debe apuntar a `GET /health`. _Comprobar:_ `GET /health` responde `200` y un JSON con
   `status` en «ok».
6. **Crear el sitio de la web** compilando con `VITE_API_URL` apuntando a la API de PRE. Todas las rutas deben
   devolver `index.html` (es una aplicación de una sola página). _Comprobar:_ abre la web: el panel «Estado del
   servicio» dice «En línea».
7. **Comprobar el CORS desde el navegador:** si el panel dice «Sin conexión» con la API en pie, la consola dice
   «blocked by CORS policy» y falta o sobra algo en `CORS_ORIGINS`.
8. **Pasar Lighthouse** sobre la dirección de PRE (accesibilidad 100).
9. **Anotar** en este documento las direcciones y quién opera cada panel.

**Si algo sale mal en PRE:** vuelve a publicar la imagen o la compilación anterior desde el panel del host. Una
migración **no** se revierte sola; por eso se aplica con cuidado y a mano.

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
