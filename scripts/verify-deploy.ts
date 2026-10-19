import { runDeployChecks, WAKE_LIMIT_MS, type DeployProbes } from './deploy-verification.ts';
import { exitCodeOf, formatReport } from './pre-verification.ts';

// npm run verify:deploy: comprueba los hosts de PRE una vez creados, la API en Render y la web en Cloudflare Pages (ADR 0031).
// Lo corre UNA PERSONA, con las direcciones como argumentos o en PRE_API_URL y PRE_WEB_URL (que no son secretas). Hace unas diez
// peticiones HTTP a esos hosts y nada mas: no toca ninguna base ni pide ninguna clave. Imprime un informe y sale con 0 solo si
// todo paso.
//
//   npm run verify:deploy -- https://vsd-stock-api-pre.onrender.com https://vsd-stock-pre.pages.dev

/** Mas que lo que una persona espera a que la API despierte: la comprobacion de «tarda demasiado» la hace el informe. */
const REQUEST_TIMEOUT_MS = WAKE_LIMIT_MS + 10_000;

const probes: DeployProbes = {
  request: async (url, options) => {
    const started = performance.now();
    const response = await fetch(url, {
      method: options?.method ?? 'GET',
      ...(options?.headers === undefined ? {} : { headers: { ...options.headers } }),
      // Un redireccionamiento no se sigue: lo que se mide es lo que contesta esa direccion, no otra.
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return { status: response.status, headers, body, elapsedMs: performance.now() - started };
  },
};

const [apiArgument, webArgument] = process.argv.slice(2);
const checks = await runDeployChecks({
  apiUrl: apiArgument ?? process.env['PRE_API_URL'],
  webUrl: webArgument ?? process.env['PRE_WEB_URL'],
  probes,
});
console.log(formatReport(checks));
process.exitCode = exitCodeOf(checks);
