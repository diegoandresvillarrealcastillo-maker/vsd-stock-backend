# ADR 0033 — La landing vive en `sitio/` del frontend y se publica como un proyecto aparte

- **Estado:** Aceptada
- **Fecha:** 2026-10-22
- **Ciclo:** 4

## Contexto

VSD Stock necesita una página pública: qué es, para quién, cómo se ve una venta sin internet y, con la misma claridad, lo que todavía no hace.
Diego la puso en el alcance del Ciclo 4 el 22 de octubre, por encima de la fecha de entrega, con estas decisiones: el naranja de la marca como
único acento, el contacto por un chat de WhatsApp, ningún precio, la demo de PRE enlazada públicamente y un subdominio temporal hasta que haya
dominio. Lo que queda por decidir es **dónde vive el código y cómo se publica**, y las condiciones salen del proyecto:

- **El JavaScript de la aplicación está en 172,1 KB de 180 KB** de su presupuesto (C3-07): `npm run budget` falla en el CI si se pasa.
  Una página de presentación con animaciones, tipografías y demos no cabe ahí, y tampoco debe: quien abre el mostrador no tiene que pagar por
  una página que no usa.
- **El service worker de la aplicación responde con la aplicación a cualquier visita** del mismo origen (ADR 0030, `docs/aplicacion-instalable.md`
  del frontend). Una landing servida en `/` junto a la aplicación quedaría escondida detrás de ella en cuanto alguien la instale.
- **La demo de IVA de la página tiene que decir lo mismo que el producto.** El cálculo vive en el dominio del frontend (ADR 0014); copiarlo
  haría que una cifra de la landing pudiera desviarse de la real sin que nada lo notara.
- **PRE y PROD no cambian:** PROD sigue en pausa y la web de PRE se publica por subida directa porque el panel de Cloudflare de Diego solo
  ofrece crear un Worker (ADR 0031). Nada de lo que se decide aquí crea ni configura ninguno de los dos.
- **Hay que poder decir la verdad:** la landing no puede afirmar lo que el producto no hace (no emite factura electrónica, no procesa
  tarjetas, no tiene precios definidos). Eso se tiene que poder vigilar con pruebas, como se hizo con el ADR 0032.

## Decisión

1. **La landing vive en `sitio/`, en el repositorio del frontend,** con su propia entrada de Vite (`sitio/vite.config.ts`), su propia salida
   (`sitio/dist/`, fuera de `dist/`) y sus propios comandos: `npm run dev:sitio`, `build:sitio` y `preview:sitio`. No comparte con la aplicación
   el paquete que se descarga, el presupuesto de peso ni el service worker.
2. **Se publica como un proyecto independiente de Cloudflare Pages (`vsd-stock-sitio`), por subida directa** desde `sitio/dist/` (el mismo
   camino que la web de PRE, ADR 0031), en un **subdominio temporal** de `pages.dev` hasta que haya dominio. La dirección final es un cambio
   de configuración, no de código. Cada rama puede tener una vista previa; la **producción solo desde `desarrollo` ya fusionado**.
3. **Misma pila y mismos tokens:** React, Tailwind v4 con los tokens del producto (los mismos nombres y valores) y Framer Motion con
   `LazyMotion` (ADR 0008). El HTML se prerenderiza al compilar para que el texto esté en la página sin ejecutar JavaScript. Las tipografías
   son fuentes propias, servidas desde el mismo sitio: la página no le pide nada a terceros.
4. **Puede importar el dominio puro (`src/domain`) y las imágenes de las mascotas (`src/presentation/assets/mascotas`),** y nada más de la
   aplicación: no importa de `application/`, `adapters/` ni `infrastructure/`, ni del resto de `presentation/`. La demo de IVA usa
   `splitTaxIncluded` y `summarizeSale`, no una copia. Los tokens de diseño no son un import del código sino un `@import` de CSS
   (`src/presentation/styles/index.css`): los mismos nombres y valores, no una copia. Lo impone ESLint en el frontend
   (`eslint/boundaries.mjs`), y la carpeta de la landing se llama `pagina/` y no `src/` para que la regla no confunda lo suyo con lo de la aplicación.
5. **No recoge nada:** ni formularios, ni cookies, ni analítica. El contacto es un enlace `wa.me` que abre un chat de WhatsApp con el mensaje
   ya escrito. Sin datos propios no hace falta política de tratamiento en la página; quien escriba por WhatsApp lo hace en esa aplicación.
6. **Todo lo que la página dice sale de un solo archivo de contenido,** y una prueba vigila que no afirme lo que el producto no hace: factura
   electrónica o cumplimiento ante la DIAN fuera de la sección de límites, pagos con tarjeta, precios, «open source» (los repositorios son
   públicos pero no tienen licencia), nombres de competidores y testimonios inventados. Las cifras y los ejemplos de IVA se comparan con el dominio.
7. **La demo de PRE se enlaza públicamente.** Un chip junto a ella avisa de que los datos son ficticios y de que puede tardar unos 25
   segundos en despertar; para saberlo hace **una sola** consulta `GET /health` a la API de PRE en modo `no-cors`, una vez por carga y solo
   cuando el chip entra en pantalla, con tiempo máximo; **no se agrega ningún origen al CORS de la API** (ADR 0012): la respuesta es opaca y
   solo dice si el servidor contestó.

## Alternativas consideradas

- **Dentro del paquete de la aplicación (una ruta `/` o una carga diferida):** pasaría el presupuesto de peso o lo obligaría a subir, y el
  service worker la taparía. El problema no es solo el tamaño, es que la aplicación y la página son productos distintos para personas distintas.
- **Un tercer repositorio:** contradice el [ADR 0001](0001-dos-repositorios-independientes.md) (los dos repositorios son el producto), duplica el CI,
  los tokens y las reglas de estilo, y no podría importar el dominio sin publicarlo como paquete. Se reconsidera si algún día la landing
  cambia de dueño o de equipo.
- **Vercel:** su plan gratuito (_Hobby_) es solo para uso personal y no comercial, según su documentación (comprobado el 2026-10-22 en
  fuentes secundarias; no se leyó su página de uso justo), y esta es la página de un negocio. Cloudflare Pages ya está en uso, tiene la subida
  directa ya probada y es el que decidió el [ADR 0031](0031-hosts-de-pre-render-y-cloudflare-pages.md). Como la página es estática, cambiar de
  host después es barato.
- **Otro generador de sitios (Astro u otro):** es un buen candidato para páginas de contenido, pero suma una herramienta, otro lenguaje de
  plantillas y otra forma de probar. Vite y React ya están, y el prerenderizado son unas pocas líneas.
- **Una página sin prerenderizar (aplicación de una sola página):** el texto no estaría en el HTML, la primera pintura esperaría al JavaScript y
  los buscadores verían una página vacía.
- **Un formulario de contacto:** obliga a guardar datos de terceros, a una política de tratamiento y a un lugar donde guardarlos y
  protegerlos. WhatsApp evita las tres cosas; es la decisión de Diego.
- **Analítica de visitas:** cookies o un servicio de terceros; no se justifica antes de saber qué se quiere medir.

## Consecuencias

### A favor

- **La aplicación no se toca:** ni su peso, ni su service worker, ni su CI. Si la landing se rompe, el mostrador no se entera.
- **Reutiliza lo que ya funciona:** el CI, los tokens (con sus pruebas de contraste), el dominio y la forma de publicar de PRE.
- **No puede mentir con las cifras:** la demo de IVA usa el mismo cálculo del producto y las frases prohibidas fallan en el CI.
- **Sin terceros ni cookies:** no hay nada que avisar ni que proteger en la propia página.
- **Se publica y se revierte sola:** es un sitio estático; una versión mala se reemplaza con la anterior.

### En contra

- **Dos compilaciones, dos salidas y dos proyectos de Pages** que alguien tiene que cuidar. `npm run build` de la aplicación y `build:sitio` son
  comandos distintos y el CI tiene que correr los dos.
- **El número de WhatsApp es público:** quedará escrito en el código y en la página, y recibirá mensajes no deseados. Si el número cambia hay
  que volver a publicar.
- **No hay despliegue automático:** como PRE, la página cambia cuando alguien corre el comando. Hasta que se decida otro camino, olvidar publicarla
  deja una versión vieja sin aviso.
- **El chip de la demo puede despertar la API de PRE.** No es un ping periódico (el [ADR 0031](0031-hosts-de-pre-render-y-cloudflare-pages.md)
  advierte contra esos), pero un tráfico sostenido sobre la landing la mantendría despierta casi todo el mes: 744 de 750 horas gratuitas
  de Render. Si pasa, o se acepta un plan que no se duerma o se quita el aviso.
- **`no-cors` da una respuesta opaca:** dice que el servidor contestó, no que esté sano. Una API que contesta con un error se vería «despierta».
- **Un subdominio `pages.dev` no es una marca** y no inspira confianza a quien no conoce el producto; la página tiene que sostenerse sola
  hasta que haya dominio.
- **Mantener la página honesta cuesta trabajo:** cada frase nueva pasa por la tabla de afirmaciones y por su prueba, y las que dependen de
  algo que aún no se midió (la velocidad en un teléfono real) no se publican.
- **Sin analítica no sabremos cuánta gente llega** ni de dónde: cualquier decisión sobre la página se toma sin datos de uso.
- **La demo de PRE se ve desde una página pública:** usa datos ficticios y una API gratuita que se duerme; cualquiera la puede abrir.
- **Las cifras envejecen:** el peso de la aplicación (172,1 KB) y el tiempo de despertar (unos 25 s) son los del
  22 de octubre; este ADR no se edita, se reemplaza.
