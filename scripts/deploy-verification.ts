import type { Check, CheckStatus } from './pre-verification.ts';

/**
 * Lo que se comprueba de los hosts de PRE una vez que una persona los creo (ADR 0031): la API por HTTPS (que responde, cuanto
 * tarda en despertar, que llega a su base, que sabe leer tokens y a quien deja leer sus respuestas) y la web (su pagina, sus rutas,
 * su service worker, su manifiesto y sus archivos). Este modulo solo decide: lo que toca la red lo traen las sondas, para poder
 * ejercitarlo con respuestas de mentira. Y no imprime lo que los hosts contestaron: solo lo que se concluye de ello.
 */

export interface HttpResult {
  readonly status: number;
  /** Los nombres de las cabeceras, en minuscula. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Cuanto tardo la respuesta, en milisegundos. */
  readonly elapsedMs: number;
}

export interface DeployProbes {
  /** Hace una peticion y espera la respuesta. Lanza si no hubo (sin red, tiempo agotado, certificado malo). */
  request(
    url: string,
    options?: { method?: 'GET' | 'OPTIONS'; headers?: Readonly<Record<string, string>> },
  ): Promise<HttpResult>;
}

export interface DeployInputs {
  /** `PRE_API_URL`: la direccion de la API en PRE. */
  readonly apiUrl: string | undefined;
  /** `PRE_WEB_URL`: la direccion de la web en PRE. Sin ella solo se comprueba la API. */
  readonly webUrl: string | undefined;
  readonly probes: DeployProbes;
}

/** Lo mas que una persona espera a que la API despierte: la gratuita se duerme a los 15 minutos y tarda alrededor de uno. */
export const WAKE_LIMIT_MS = 120_000;
/** Mas lento que esto, la primera respuesta fue la de una API dormida. */
const ASLEEP_MS = 5_000;
/** Con la API despierta, una segunda respuesta mas lenta que esto es mala senal: puede que se este durmiendo otra vez. */
const WARM_LIMIT_MS = 3_000;
const YEAR_SECONDS = 31_536_000;
const MAX_DETAIL = 240;
const FOREIGN_ORIGIN = 'https://sitio-ajeno.example';

const check = (id: string, title: string, status: CheckStatus, detail: string): Check => ({
  id,
  title,
  status,
  detail,
});

const seconds = (ms: number): string => String(Math.round(ms / 1000));

/** Lo que dice un error sin su pila: su primera linea y corta. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return 'error desconocido';
  const first = error.message.split('\n')[0] ?? '';
  return first.length > MAX_DETAIL ? `${first.slice(0, MAX_DETAIL)}…` : first;
}

type Parsed =
  { readonly ok: true; readonly origin: string } | { readonly ok: false; readonly why: string };

/** Una direccion de host: HTTPS, sin usuario, sin ruta y que no sea local. Devuelve su origen, sin barra final. */
function parseHost(raw: string, name: string): Parsed {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return {
      ok: false,
      why: `${name} no es una dirección: escríbela completa, como https://servicio.ejemplo.`,
    };
  }
  if (url.protocol !== 'https:') {
    return {
      ok: false,
      why: `${name} tiene que ser HTTPS: sin él no hay service worker, ni cifrado en el equipo, ni cámara.`,
    };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, why: `${name} lleva usuario y contraseña: no deben ir en la dirección.` };
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return { ok: false, why: `${name} va sin ruta ni parámetros: solo el servidor.` };
  }
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') {
    return { ok: false, why: `${name} es una dirección local: PRE son los hosts de verdad.` };
  }
  return { ok: true, origin: url.origin };
}

/** Pide algo y devuelve la respuesta, o lo que fallo ya descrito. */
async function ask(
  probes: DeployProbes,
  url: string,
  options?: Parameters<DeployProbes['request']>[1],
): Promise<{ result: HttpResult } | { failure: string }> {
  try {
    return { result: await probes.request(url, options) };
  } catch (error) {
    return { failure: describeError(error) };
  }
}

const skipped = (id: string, title: string, why: string): Check => check(id, title, 'skip', why);

/** Las comprobaciones de la API. `null` en `origin` quiere decir que no hay una direccion valida. */
async function checkApi(
  api: string | null,
  web: string | null,
  probes: DeployProbes,
  unavailable: string,
): Promise<Check[]> {
  const titles = {
    health: 'La API responde',
    wake: 'Despierta a tiempo',
    warm: 'Sigue rápida una vez despierta',
    ready: 'La API llega a su base de datos',
    auth: 'La API sabe leer sesiones',
    allowed: 'La API deja leer sus respuestas a la web de PRE',
    closed: 'La API no deja leerlas a cualquiera',
  } as const;
  const restSkipped = (why: string): Check[] => [
    skipped('wake', titles.wake, why),
    skipped('warm', titles.warm, why),
    skipped('ready', titles.ready, why),
    skipped('auth', titles.auth, why),
    skipped('cors-allowed', titles.allowed, why),
    skipped('cors-closed', titles.closed, why),
  ];
  if (api === null) {
    return [skipped('health', titles.health, unavailable), ...restSkipped(unavailable)];
  }

  const first = await ask(probes, `${api}/health`);
  if ('failure' in first) {
    return [
      check('health', titles.health, 'fail', `No contestó: ${first.failure}.`),
      ...restSkipped('La API no contestó a /health: lo demás repetiría el mismo fallo.'),
    ];
  }
  if (first.result.status !== 200) {
    return [
      check(
        'health',
        titles.health,
        'fail',
        `GET /health respondió ${String(first.result.status)} y se esperaba 200. Mira el registro del servicio en el panel.`,
      ),
      ...restSkipped('La API no está sana: lo demás repetiría el mismo fallo.'),
    ];
  }
  const checks: Check[] = [
    check(
      'health',
      titles.health,
      'pass',
      `GET /health respondió 200 en ${seconds(first.result.elapsedMs)} s.`,
    ),
  ];

  const waited = first.result.elapsedMs;
  const asleep = waited > ASLEEP_MS;
  checks.push(
    waited > WAKE_LIMIT_MS
      ? check(
          'wake',
          titles.wake,
          'fail',
          `Tardó ${seconds(waited)} s en contestar: más de lo que una persona espera.`,
        )
      : check(
          'wake',
          titles.wake,
          'pass',
          asleep
            ? `Estaba dormida y despertó en ${seconds(waited)} s (la API gratuita se duerme a los 15 minutos sin tráfico).`
            : `Estaba despierta: contestó en ${seconds(waited)} s.`,
        ),
  );

  const second = await ask(probes, `${api}/health`);
  if ('failure' in second) {
    checks.push(
      check('warm', titles.warm, 'fail', `La segunda petición no contestó: ${second.failure}.`),
    );
  } else if (second.result.elapsedMs > WARM_LIMIT_MS) {
    checks.push(
      check(
        'warm',
        titles.warm,
        'fail',
        `La segunda respuesta tardó ${seconds(second.result.elapsedMs)} s con la API ya despierta: puede que se esté durmiendo otra vez.`,
      ),
    );
  } else {
    checks.push(
      check(
        'warm',
        titles.warm,
        'pass',
        `Contestó otra vez en ${seconds(second.result.elapsedMs)} s.`,
      ),
    );
  }

  const ready = await ask(probes, `${api}/v1/ready`);
  if ('failure' in ready) {
    checks.push(check('ready', titles.ready, 'fail', `No contestó: ${ready.failure}.`));
  } else if (ready.result.status === 200) {
    checks.push(
      check('ready', titles.ready, 'pass', 'GET /v1/ready respondió 200: la API llega a su base.'),
    );
  } else if (ready.result.status === 503) {
    checks.push(
      check(
        'ready',
        titles.ready,
        'fail',
        'GET /v1/ready respondió 503: la API no llega a su base. Revisa DATABASE_URL en el panel del host (la cadena del rol stock_app por el pooler de sesión).',
      ),
    );
  } else {
    checks.push(
      check(
        'ready',
        titles.ready,
        'fail',
        `GET /v1/ready respondió ${String(ready.result.status)} y se esperaba 200.`,
      ),
    );
  }

  const me = await ask(probes, `${api}/v1/me`);
  if ('failure' in me) {
    checks.push(check('auth', titles.auth, 'fail', `No contestó: ${me.failure}.`));
  } else if (me.result.status === 401) {
    checks.push(check('auth', titles.auth, 'pass', 'Una llamada sin sesión se rechaza con 401.'));
  } else {
    const hint =
      me.result.status === 200
        ? 'Una llamada sin sesión no debería funcionar: la API no está pidiendo la sesión.'
        : me.result.status === 503
          ? 'Revisa AUTH_JWKS_URL: la API no pudo leer las claves del servicio de identidad.'
          : me.result.status >= 500
            ? 'Revisa AUTH_ISSUER, AUTH_JWKS_URL y AUTH_AUDIENCE en el panel del host.'
            : 'Se esperaba 401.';
    checks.push(
      check(
        'auth',
        titles.auth,
        'fail',
        `GET /v1/me sin sesión respondió ${String(me.result.status)}. ${hint}`,
      ),
    );
  }

  if (web === null) {
    checks.push(
      skipped('cors-allowed', titles.allowed, 'No se dio la dirección de la web (PRE_WEB_URL).'),
    );
  } else {
    checks.push(await checkCors(api, web, probes, titles.allowed));
  }
  checks.push(await checkClosedCors(api, probes, titles.closed));
  return checks;
}

async function preflight(
  api: string,
  origin: string,
  probes: DeployProbes,
): Promise<{ allowed: string | undefined } | { failure: string }> {
  const answer = await ask(probes, `${api}/v1/me`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': 'authorization',
    },
  });
  if ('failure' in answer) return { failure: answer.failure };
  return { allowed: answer.result.headers['access-control-allow-origin'] };
}

async function checkCors(
  api: string,
  web: string,
  probes: DeployProbes,
  title: string,
): Promise<Check> {
  const answer = await preflight(api, web, probes);
  if ('failure' in answer)
    return check('cors-allowed', title, 'fail', `No contestó: ${answer.failure}.`);
  return answer.allowed === web
    ? check('cors-allowed', title, 'pass', 'La API le da permiso a la dirección de la web.')
    : check(
        'cors-allowed',
        title,
        'fail',
        'La API no le da permiso a la web: el navegador no dejará leer sus respuestas. Pon la dirección de la web en CORS_ORIGINS, tal cual, sin barra final.',
      );
}

async function checkClosedCors(api: string, probes: DeployProbes, title: string): Promise<Check> {
  const answer = await preflight(api, FOREIGN_ORIGIN, probes);
  if ('failure' in answer)
    return check('cors-closed', title, 'fail', `No contestó: ${answer.failure}.`);
  return answer.allowed === undefined
    ? check('cors-closed', title, 'pass', 'Un sitio que nadie nombró no recibe permiso.')
    : check(
        'cors-closed',
        title,
        'fail',
        `La API le da permiso a un sitio cualquiera (${answer.allowed === '*' ? 'comodín' : 'su origen'}): CORS_ORIGINS tiene que ser una lista explícita, sin «*» (ADR 0012).`,
      );
}

const isHtml = (result: HttpResult): boolean =>
  (result.headers['content-type'] ?? '').includes('html');

/** Si la cabecera de cache obliga a volver a preguntar cada vez. */
function alwaysRevalidates(rule: string): boolean {
  const lower = rule.toLowerCase();
  return lower.includes('no-cache') || lower.includes('no-store') || /max-age=0(?!\d)/.test(lower);
}

/** Si la cabecera de cache deja guardar el archivo un anio o lo marca inmutable. */
function cachesForAYear(rule: string): boolean {
  const lower = rule.toLowerCase();
  if (lower.includes('immutable')) return true;
  const age = /max-age=(\d+)/.exec(lower);
  return age?.[1] !== undefined && Number(age[1]) >= YEAR_SECONDS;
}

async function checkWeb(web: string, probes: DeployProbes): Promise<Check[]> {
  const checks: Check[] = [];

  const index = await ask(probes, `${web}/`);
  let page: HttpResult | null = null;
  if ('failure' in index) {
    checks.push(
      check('web-index', 'La web sirve la aplicación', 'fail', `No contestó: ${index.failure}.`),
    );
  } else if (index.result.status !== 200) {
    checks.push(
      check(
        'web-index',
        'La web sirve la aplicación',
        'fail',
        `GET / respondió ${String(index.result.status)} y se esperaba 200.`,
      ),
    );
  } else if (!isHtml(index.result) || !index.result.body.includes('id="root"')) {
    checks.push(
      check(
        'web-index',
        'La web sirve la aplicación',
        'fail',
        'GET / respondió 200 pero no es la aplicación (no trae su página): ¿el proyecto apunta a la carpeta dist?',
      ),
    );
  } else {
    page = index.result;
    checks.push(
      check(
        'web-index',
        'La web sirve la aplicación',
        'pass',
        'GET / trae la página de la aplicación.',
      ),
    );
  }

  const route = await ask(probes, `${web}/mostrador`);
  if ('failure' in route) {
    checks.push(
      check(
        'web-routes',
        'Recargar en una ruta no da 404',
        'fail',
        `No contestó: ${route.failure}.`,
      ),
    );
  } else if (route.result.status === 200 && isHtml(route.result)) {
    checks.push(
      check(
        'web-routes',
        'Recargar en una ruta no da 404',
        'pass',
        'GET /mostrador trae la página de la aplicación.',
      ),
    );
  } else {
    checks.push(
      check(
        'web-routes',
        'Recargar en una ruta no da 404',
        'fail',
        `GET /mostrador respondió ${String(route.result.status)}: la aplicación tiene que servirse desde cualquier ruta (en Cloudflare Pages, sin un 404.html propio).`,
      ),
    );
  }

  checks.push(await checkServiceWorker(web, probes));
  checks.push(await checkManifest(web, probes));
  checks.push(await checkAssets(web, page, probes));
  return checks;
}

async function checkServiceWorker(web: string, probes: DeployProbes): Promise<Check> {
  const title = 'El service worker se encuentra y se renueva';
  const answer = await ask(probes, `${web}/sw.js`);
  if ('failure' in answer) return check('web-sw', title, 'fail', `No contestó: ${answer.failure}.`);
  const { result } = answer;
  if (result.status !== 200) {
    return check(
      'web-sw',
      title,
      'fail',
      `GET /sw.js respondió ${String(result.status)} y se esperaba 200.`,
    );
  }
  if (!(result.headers['content-type'] ?? '').includes('javascript')) {
    return check(
      'web-sw',
      title,
      'fail',
      'GET /sw.js no se sirve como JavaScript: el navegador no lo instalaría.',
    );
  }
  const rule = result.headers['cache-control'] ?? '';
  if (!alwaysRevalidates(rule)) {
    return check(
      'web-sw',
      title,
      'fail',
      'GET /sw.js se puede guardar en caché: una versión nueva tardaría en encontrarse. Sírvelo con Cache-Control: no-cache (public/_headers).',
    );
  }
  return check(
    'web-sw',
    title,
    'pass',
    'GET /sw.js se sirve como JavaScript y siempre se vuelve a preguntar.',
  );
}

async function checkManifest(web: string, probes: DeployProbes): Promise<Check> {
  const title = 'El manifiesto está';
  const answer = await ask(probes, `${web}/manifest.webmanifest`);
  if ('failure' in answer)
    return check('web-manifest', title, 'fail', `No contestó: ${answer.failure}.`);
  if (answer.result.status !== 200) {
    return check(
      'web-manifest',
      title,
      'fail',
      `GET /manifest.webmanifest respondió ${String(answer.result.status)} y se esperaba 200.`,
    );
  }
  try {
    const manifest = JSON.parse(answer.result.body) as { name?: unknown };
    return typeof manifest.name === 'string' && manifest.name !== ''
      ? check(
          'web-manifest',
          title,
          'pass',
          'GET /manifest.webmanifest trae el nombre de la aplicación.',
        )
      : check('web-manifest', title, 'fail', 'El manifiesto no trae el nombre de la aplicación.');
  } catch {
    return check('web-manifest', title, 'fail', 'El manifiesto no es un JSON.');
  }
}

async function checkAssets(
  web: string,
  page: HttpResult | null,
  probes: DeployProbes,
): Promise<Check> {
  const title = 'Los archivos de la interfaz se sirven y se guardan';
  if (page === null)
    return skipped('web-assets', title, 'La página de la aplicación no se pudo leer.');
  const found = /(?:src|href)="(\/assets\/[^"]+)"/.exec(page.body);
  const path = found?.[1];
  if (path === undefined)
    return skipped('web-assets', title, 'La página no pide ningún archivo de /assets/.');
  const answer = await ask(probes, `${web}${path}`);
  if ('failure' in answer)
    return check('web-assets', title, 'fail', `${path} no contestó: ${answer.failure}.`);
  if (answer.result.status !== 200) {
    return check(
      'web-assets',
      title,
      'fail',
      `${path} respondió ${String(answer.result.status)}: la página pide un archivo que no está.`,
    );
  }
  return cachesForAYear(answer.result.headers['cache-control'] ?? '')
    ? check(
        'web-assets',
        title,
        'pass',
        `${path} se sirve y se guarda un año (su nombre lleva su huella).`,
      )
    : check(
        'web-assets',
        title,
        'pass',
        `${path} se sirve, pero sin caché larga: se bajaría de nuevo en cada visita (public/_headers).`,
      );
}

/** Todas las comprobaciones, en el orden en que se cuentan. Nunca lanza: lo que falla queda en el informe. */
export async function runDeployChecks(inputs: DeployInputs): Promise<Check[]> {
  const checks: Check[] = [];

  let api: string | null = null;
  if (inputs.apiUrl === undefined || inputs.apiUrl.trim() === '') {
    checks.push(
      check(
        'api-url',
        'Dirección de la API',
        'fail',
        'Falta PRE_API_URL: la dirección de la API en PRE, por ejemplo https://vsd-stock-api-pre.onrender.com.',
      ),
    );
  } else {
    const parsed = parseHost(inputs.apiUrl.trim(), 'PRE_API_URL');
    if (parsed.ok) {
      api = parsed.origin;
      checks.push(
        check(
          'api-url',
          'Dirección de la API',
          'pass',
          'Es una dirección HTTPS sin usuario ni ruta.',
        ),
      );
    } else {
      checks.push(check('api-url', 'Dirección de la API', 'fail', parsed.why));
    }
  }

  let web: string | null = null;
  if (inputs.webUrl === undefined || inputs.webUrl.trim() === '') {
    checks.push(
      check(
        'web-url',
        'Dirección de la web',
        'skip',
        'No se dio PRE_WEB_URL: solo se comprueba la API.',
      ),
    );
  } else {
    const parsed = parseHost(inputs.webUrl.trim(), 'PRE_WEB_URL');
    if (parsed.ok) {
      web = parsed.origin;
      checks.push(
        check(
          'web-url',
          'Dirección de la web',
          'pass',
          'Es una dirección HTTPS sin usuario ni ruta.',
        ),
      );
    } else {
      checks.push(check('web-url', 'Dirección de la web', 'fail', parsed.why));
    }
  }

  checks.push(...(await checkApi(api, web, inputs.probes, 'Sin una dirección válida de la API.')));
  if (web !== null) checks.push(...(await checkWeb(web, inputs.probes)));
  return checks;
}
