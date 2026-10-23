import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// La landing de VSD Stock vive en `sitio/` del frontend y se publica aparte (ADR 0033). Estas pruebas vigilan que la decision siga
// escrita completa: donde vive, por que no va dentro de la aplicacion, como se publica, que no recoge y que no se le permite decir.
// Cada frase se busca en SU seccion: una frase que tambien aparece en otra (la de «factura electronica» esta en el contexto y en la
// decision) no puede salvar a una decision a la que se le quito.

const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string): string =>
  readFileSync(join(ROOT, path), 'utf8').replaceAll('\r\n', '\n');
/** Una frase como se lee: partida entre dos lineas (Prettier ajusta la prosa) sigue siendo la misma frase. */
const prose = (path: string): string => read(path).replaceAll(/\s+/g, ' ');

const ADR = 'docs/adr/0033-la-landing-vive-en-sitio-del-frontend-y-se-publica-aparte.md';

describe('ADR 0033: la landing vive en sitio/ y se publica aparte', () => {
  const adr = prose(ADR);
  const between = (from: string, to?: string): string =>
    adr.slice(adr.indexOf(from), to === undefined ? undefined : adr.indexOf(to));
  const context = between('## Contexto', '## Decisión');
  const decision = between('## Decisión', '## Alternativas consideradas');
  const alternatives = between('## Alternativas consideradas', '## Consecuencias');
  const inFavour = between('### A favor', '### En contra');
  const against = between('### En contra');

  /** Un punto numerado de la decision: «3. **Misma pila…» hasta el siguiente. */
  const point = (n: number): string => {
    const start = decision.indexOf(` ${String(n)}. **`);
    const end = decision.indexOf(` ${String(n + 1)}. **`);
    return decision.slice(start, end === -1 ? undefined : end);
  };

  it('is the next ADR of cycle 4 and is listed in the index', () => {
    expect(existsSync(join(ROOT, ADR))).toBe(true);
    expect(read('docs/adr/README.md')).toContain(
      '(0033-la-landing-vive-en-sitio-del-frontend-y-se-publica-aparte.md)',
    );
    expect(adr).toMatch(/- \*\*Ciclo:\*\* 4/);
  });

  it('has the five sections and the points of the decision in order', () => {
    expect(context.length).toBeGreaterThan(200);
    expect(alternatives.length).toBeGreaterThan(200);
    expect(inFavour.length).toBeGreaterThan(100);
    expect(against.length).toBeGreaterThan(200);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) expect(point(n).length).toBeGreaterThan(50);
  });

  it('says where it lives: sitio/ of the frontend, with its own build and its own output', () => {
    const first = point(1);
    expect(first).toContain('`sitio/`');
    expect(first).toContain('repositorio del frontend');
    expect(first).toContain('`sitio/dist/`');
    expect(first).toMatch(/dev:sitio.*build:sitio.*preview:sitio/);
  });

  it('says why it cannot go inside the app: the size budget and the service worker', () => {
    expect(context).toContain('172,1 KB de 180 KB');
    expect(context).toMatch(
      /service worker de la aplicaci[oó]n responde con la aplicaci[oó]n a cualquier visita/,
    );
  });

  it('says how it is published: its own Cloudflare Pages project, by direct upload, on a temporary subdomain', () => {
    const second = point(2);
    expect(second).toContain('Cloudflare Pages');
    expect(second).toContain('`vsd-stock-sitio`');
    expect(second).toContain('subida directa');
    expect(second).toContain('subdominio temporal');
    expect(second).toMatch(/producción solo desde `desarrollo` ya fusionado/);
  });

  it('keeps the same stack and tokens, prerenders the HTML and serves its own fonts', () => {
    const third = point(3);
    expect(third).toContain('Tailwind');
    expect(third).toContain('Framer Motion');
    expect(third).toContain('prerenderiza');
    expect(third).toMatch(/fuentes propias/);
  });

  it('lets it import the pure domain and nothing else of the app', () => {
    const fourth = point(4);
    expect(fourth).toContain('`src/domain`');
    expect(fourth).toContain('`src/presentation/assets/mascotas`');
    expect(fourth).toMatch(
      /no importa de `application\/`, `adapters\/` ni `infrastructure\/`, ni del resto de `presentation\/`/,
    );
    expect(fourth).toMatch(
      /Los tokens de diseño no son un import del código sino un `@import` de CSS/,
    );
    expect(fourth).toContain('`eslint/boundaries.mjs`');
    expect(fourth).toContain('`pagina/`');
  });

  it('collects nothing: no forms, no cookies, no analytics; contact is a WhatsApp link', () => {
    const fifth = point(5);
    expect(fifth).toMatch(/ni formularios, ni cookies, ni analítica/);
    expect(fifth).toContain('`wa.me`');
    expect(fifth).toMatch(/abre un chat de WhatsApp/);
  });

  it('keeps every claim in one content file guarded by a test', () => {
    const sixth = point(6);
    expect(sixth).toContain('un solo archivo de contenido');
    expect(sixth).toMatch(/factura electrónica/);
    expect(sixth).toMatch(/pagos con tarjeta/);
    expect(sixth).toMatch(/precios/);
    expect(sixth).toMatch(/open source/);
    expect(sixth).toMatch(/nombres de competidores/);
    expect(sixth).toMatch(/testimonios inventados/);
    expect(sixth).toMatch(/se comparan con el dominio/);
  });

  it('links the demo of PRE and asks its API in no-cors mode without opening the CORS list', () => {
    const seventh = point(7);
    expect(seventh).toContain('`GET /health`');
    expect(seventh).toContain('`no-cors`');
    expect(seventh).toMatch(/no se agrega ningún origen al CORS de la API/);
    expect(seventh).toMatch(/datos son ficticios/);
    expect(seventh).toMatch(/unos 25 segundos/);
    expect(seventh).toMatch(/una vez por carga y solo cuando el chip entra en pantalla/);
  });

  it('records the alternatives it discarded, Vercel among them', () => {
    expect(alternatives).toContain('Vercel');
    expect(alternatives).toMatch(/solo para uso personal y no comercial/);
    expect(alternatives).toContain('tercer repositorio');
    expect(alternatives).toContain('formulario');
    expect(alternatives).toMatch(/sin prerenderizar/);
  });

  it('says what it costs: two builds, a public number, a demo that wakes up and the opaque answer', () => {
    expect(against).toMatch(/Dos compilaciones, dos salidas y dos proyectos de Pages/);
    expect(against).toMatch(/número de WhatsApp es público/);
    expect(against).toMatch(/744 de 750/);
    expect(against).toMatch(/respuesta opaca/);
    expect(against).toMatch(/No hay despliegue automático/);
    expect(against).toMatch(/Sin analítica/);
    expect(against).toMatch(/Mantener la página honesta cuesta trabajo/);
    expect(against).toMatch(/no es una marca/);
    expect(against).toMatch(/Las cifras envejecen/);
  });

  it('cites the ADRs it depends on, and they exist', () => {
    for (const number of ['0001', '0008', '0012', '0030', '0031']) {
      expect(adr).toContain(`ADR ${number}`);
    }
    for (const link of adr.matchAll(/\]\((\d{4}-[^)]+\.md)\)/g)) {
      expect(existsSync(join(ROOT, 'docs/adr', link[1] ?? ''))).toBe(true);
    }
  });
});
