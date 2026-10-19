import { describe, expect, it } from 'vitest';
import {
  runDeployChecks,
  WAKE_LIMIT_MS,
  type DeployProbes,
  type HttpResult,
} from '../../scripts/deploy-verification.ts';
import { exitCodeOf, formatReport, type Check } from '../../scripts/pre-verification.ts';

// Lo que se comprueba de los hosts de PRE una vez que una persona los creo (ADR 0031): la API por HTTPS, su base, su CORS y la
// web con su service worker. Este modulo solo decide: lo que toca la red lo traen las sondas, que aqui son de mentira.

const API = 'https://vsd-stock-api-pre.onrender.com';
const WEB = 'https://vsd-stock-pre.pages.dev';

const reply = (status: number, partial: Partial<HttpResult> = {}): HttpResult => ({
  status,
  headers: {},
  body: '',
  elapsedMs: 120,
  ...partial,
});

/** Los hosts de PRE como deberian estar. Cada prueba cambia solo lo suyo. */
function hosts(overrides: Record<string, HttpResult | Error> = {}): {
  probes: DeployProbes;
  asked: string[];
} {
  const answers: Record<string, HttpResult | Error> = {
    [`GET ${API}/health`]: reply(200, { body: '{"status":"ok"}', elapsedMs: 300 }),
    [`GET ${API}/v1/ready`]: reply(200, { body: '{"status":"ready"}' }),
    [`GET ${API}/v1/me`]: reply(401),
    [`OPTIONS ${API}/v1/me origin=${WEB}`]: reply(204, {
      headers: { 'access-control-allow-origin': WEB },
    }),
    [`OPTIONS ${API}/v1/me origin=https://sitio-ajeno.example`]: reply(204),
    [`GET ${WEB}/`]: reply(200, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body><div id="root"></div><script src="/assets/index-abc.js"></script></body></html>',
    }),
    [`GET ${WEB}/mostrador`]: reply(200, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body><div id="root"></div></body></html>',
    }),
    [`GET ${WEB}/sw.js`]: reply(200, {
      headers: { 'content-type': 'text/javascript', 'cache-control': 'no-cache' },
      body: 'self.addEventListener("install", () => {});',
    }),
    [`GET ${WEB}/manifest.webmanifest`]: reply(200, {
      headers: { 'content-type': 'application/manifest+json' },
      body: '{"name":"VSD Stock"}',
    }),
    [`GET ${WEB}/assets/index-abc.js`]: reply(200, {
      headers: {
        'content-type': 'text/javascript',
        'cache-control': 'public, max-age=31536000, immutable',
      },
      body: 'console.log(1)',
    }),
    ...overrides,
  };
  const asked: string[] = [];
  const probes: DeployProbes = {
    request: (url, options) => {
      const origin = options?.headers?.['Origin'];
      const key = `${options?.method ?? 'GET'} ${url}${origin === undefined ? '' : ` origin=${origin}`}`;
      asked.push(key);
      const answer = answers[key];
      if (answer === undefined) return Promise.reject(new Error(`sin respuesta preparada: ${key}`));
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { probes, asked };
}

const run = async (
  inputs: { apiUrl?: string | undefined; webUrl?: string | undefined },
  overrides: Record<string, HttpResult | Error> = {},
) => {
  const { probes, asked } = hosts(overrides);
  const checks = await runDeployChecks({ apiUrl: inputs.apiUrl, webUrl: inputs.webUrl, probes });
  return { checks, asked };
};
const byId = (checks: readonly Check[], id: string): Check => {
  const found = checks.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no hay una comprobacion ${id}`);
  return found;
};

describe('the addresses that were given', () => {
  it('asks for the address of the API: without it there is nothing to check', async () => {
    const { checks, asked } = await run({});

    expect(byId(checks, 'api-url')).toMatchObject({ status: 'fail' });
    expect(byId(checks, 'api-url').detail).toContain('PRE_API_URL');
    expect(asked).toEqual([]);
  });

  it.each([
    ['http://vsd.onrender.com', 'HTTPS'],
    ['vsd.onrender.com', 'dirección'],
    ['https://vsd.onrender.com/v1', 'sin ruta'],
    ['https://usuario:clave@vsd.onrender.com', 'usuario'],
    ['https://localhost:3000', 'local'],
    ['https://127.0.0.1:3000', 'local'],
    ['https://[::1]:3000', 'local'],
    ['https://:clave@vsd.onrender.com', 'usuario'],
    ['https://usuario@vsd.onrender.com', 'usuario'],
    ['https://vsd.onrender.com/?x=1', 'sin ruta'],
    ['https://vsd.onrender.com/#a', 'sin ruta'],
  ])('refuses %s', async (apiUrl, reason) => {
    const { checks, asked } = await run({ apiUrl });

    expect(byId(checks, 'api-url')).toMatchObject({ status: 'fail' });
    expect(byId(checks, 'api-url').detail).toContain(reason);
    expect(asked).toEqual([]);
  });

  it('asks for the address of the API also when it was written as blank space', async () => {
    const { checks, asked } = await run({ apiUrl: '   ' });

    expect(byId(checks, 'api-url').detail).toContain('Falta PRE_API_URL');
    expect(asked).toEqual([]);
  });

  it('does not take a web address that is only blank space for one: it was not given', async () => {
    const { checks } = await run({ apiUrl: API, webUrl: '   ' });

    expect(byId(checks, 'web-url').status).toBe('skip');
  });

  it('accepts a trailing slash: it is the same address', async () => {
    const { checks } = await run({ apiUrl: `${API}/` });

    expect(byId(checks, 'api-url').status).toBe('pass');
    expect(byId(checks, 'health').status).toBe('pass');
  });

  it('refuses a web address that is not HTTPS: without it there is no service worker, nor encryption, nor camera', async () => {
    const { checks } = await run({ apiUrl: API, webUrl: 'http://vsd-stock-pre.pages.dev' });

    expect(byId(checks, 'web-url')).toMatchObject({ status: 'fail' });
    expect(byId(checks, 'web-url').detail).toContain('HTTPS');
  });

  it('skips what is about the web when no address of it was given, and says so', async () => {
    const { checks, asked } = await run({ apiUrl: API });

    expect(byId(checks, 'web-url')).toMatchObject({ status: 'skip' });
    expect(byId(checks, 'cors-allowed').status).toBe('skip');
    expect(asked.some((key) => key.includes(WEB))).toBe(false);
  });
});

describe('the API', () => {
  it('answers on /health, and says how long it took', async () => {
    const { checks } = await run({ apiUrl: API });

    expect(byId(checks, 'health')).toMatchObject({ status: 'pass' });
    expect(byId(checks, 'health').detail).toContain('200');
  });

  it('fails when /health does not answer 200', async () => {
    const { checks } = await run(
      { apiUrl: API },
      { [`GET ${API}/health`]: reply(502, { body: 'Bad Gateway' }) },
    );

    expect(byId(checks, 'health')).toMatchObject({ status: 'fail' });
    expect(byId(checks, 'health').detail).toContain('502');
    expect(byId(checks, 'ready').status).toBe('skip');
    expect(byId(checks, 'auth').status).toBe('skip');
    expect(byId(checks, 'cors-allowed').status).toBe('skip');
  });

  it('fails, without throwing, when the request does not even get an answer', async () => {
    const { checks } = await run(
      { apiUrl: API },
      { [`GET ${API}/health`]: new Error('fetch failed\n    at algo secreto') },
    );

    expect(byId(checks, 'health')).toMatchObject({ status: 'fail' });
    expect(byId(checks, 'health').detail).toContain('fetch failed');
    expect(byId(checks, 'health').detail).not.toContain('secreto');
  });

  it('does not go on asking the API when it did not answer once: the rest would only repeat the same failure', async () => {
    const { checks, asked } = await run(
      { apiUrl: API, webUrl: WEB },
      { [`GET ${API}/health`]: new Error('fetch failed') },
    );

    expect(byId(checks, 'ready').status).toBe('skip');
    expect(byId(checks, 'auth').status).toBe('skip');
    expect(asked.filter((key) => key.includes(API))).toEqual([`GET ${API}/health`]);
  });

  describe('waking up', () => {
    it('says it was asleep, and how long it took to wake, when the first answer was slow', async () => {
      const { checks } = await run(
        { apiUrl: API },
        { [`GET ${API}/health`]: reply(200, { elapsedMs: 47_000 }) },
      );

      expect(byId(checks, 'wake')).toMatchObject({ status: 'pass' });
      expect(byId(checks, 'wake').detail).toContain('dormida');
      expect(byId(checks, 'wake').detail).toContain('47');
    });

    it('waits two minutes: a minute is what the free plan takes, and the report does not give up before', () => {
      expect(WAKE_LIMIT_MS).toBe(120_000);
    });

    it.each([
      [119_000, 'pass'],
      [120_000, 'pass'],
      [121_000, 'fail'],
    ])('wakes in %i ms: %s', async (elapsedMs, status) => {
      const { checks } = await run(
        { apiUrl: API },
        { [`GET ${API}/health`]: reply(200, { elapsedMs }) },
      );

      expect(byId(checks, 'wake').status).toBe(status);
    });

    it.each([
      [500, 'despierta'],
      [4_000, 'despierta'],
      [5_000, 'despierta'],
      [5_001, 'dormida'],
    ])('says what it was after answering in %i ms', async (elapsedMs, word) => {
      const { checks } = await run(
        { apiUrl: API },
        { [`GET ${API}/health`]: reply(200, { elapsedMs }) },
      );

      expect(byId(checks, 'wake').detail).toContain(word);
    });

    it('says it was awake when the first answer was quick', async () => {
      const { checks } = await run(
        { apiUrl: API },
        { [`GET ${API}/health`]: reply(200, { elapsedMs: 400 }) },
      );

      expect(byId(checks, 'wake').detail).toContain('despierta');
    });

    it('fails when it took longer than a person can wait', async () => {
      const { checks } = await run(
        { apiUrl: API },
        { [`GET ${API}/health`]: reply(200, { elapsedMs: WAKE_LIMIT_MS + 1 }) },
      );

      expect(byId(checks, 'wake')).toMatchObject({ status: 'fail' });
    });

    it('asks a second time, now that it is awake, and fails if it is still slow: it may be going back to sleep', async () => {
      const { probes } = hosts();
      let calls = 0;
      const slowSecond: DeployProbes = {
        request: (url, options) => {
          if (url === `${API}/health`) {
            calls += 1;
            return Promise.resolve(reply(200, { elapsedMs: calls === 1 ? 300 : 9_000 }));
          }
          return probes.request(url, options);
        },
      };

      const checks = await runDeployChecks({ apiUrl: API, webUrl: undefined, probes: slowSecond });

      expect(calls).toBe(2);
      expect(byId(checks, 'warm')).toMatchObject({ status: 'fail' });
    });

    it.each([
      [300, 'pass'],
      [2_000, 'pass'],
      [3_000, 'pass'],
      [3_001, 'fail'],
    ])('judges a second answer of %i ms: %s', async (elapsedMs, status) => {
      const { probes } = hosts();
      let calls = 0;
      const second: DeployProbes = {
        request: (url, options) => {
          if (url === `${API}/health`) {
            calls += 1;
            return Promise.resolve(reply(200, { elapsedMs: calls === 1 ? 300 : elapsedMs }));
          }
          return probes.request(url, options);
        },
      };

      const checks = await runDeployChecks({ apiUrl: API, webUrl: undefined, probes: second });

      expect(byId(checks, 'warm').status).toBe(status);
    });

    it('passes when the second answer is quick', async () => {
      const { checks } = await run({ apiUrl: API });

      expect(byId(checks, 'warm')).toMatchObject({ status: 'pass' });
    });
  });

  describe('its database', () => {
    it('passes when /v1/ready says it can reach it', async () => {
      const { checks } = await run({ apiUrl: API });

      expect(byId(checks, 'ready')).toMatchObject({ status: 'pass' });
    });

    it('fails with a 503 and says where to look: the connection string of the application', async () => {
      const { checks } = await run(
        { apiUrl: API },
        { [`GET ${API}/v1/ready`]: reply(503, { body: '{"code":"database-unavailable"}' }) },
      );

      expect(byId(checks, 'ready')).toMatchObject({ status: 'fail' });
      expect(byId(checks, 'ready').detail).toContain('DATABASE_URL');
    });

    it('fails for any other answer', async () => {
      const { checks } = await run({ apiUrl: API }, { [`GET ${API}/v1/ready`]: reply(404) });

      expect(byId(checks, 'ready')).toMatchObject({ status: 'fail' });
      expect(byId(checks, 'ready').detail).toContain('404');
    });
  });

  describe('its identity service', () => {
    it('passes when a call without a session is refused with a 401: it knows how to read tokens', async () => {
      const { checks } = await run({ apiUrl: API });

      expect(byId(checks, 'auth')).toMatchObject({ status: 'pass' });
    });

    it.each([
      [200, 'la API no está pidiendo la sesión'],
      [500, 'AUTH_AUDIENCE'],
      [503, 'las claves del servicio de identidad'],
      [404, 'Se esperaba 401'],
    ])('fails when a call without a session gets a %i', async (status, hint) => {
      const { checks } = await run({ apiUrl: API }, { [`GET ${API}/v1/me`]: reply(status) });

      expect(byId(checks, 'auth')).toMatchObject({ status: 'fail' });
      expect(byId(checks, 'auth').detail).toContain(String(status));
      expect(byId(checks, 'auth').detail).toContain(hint);
    });
  });

  describe('who may read its answers from a browser', () => {
    it('lets the web of PRE, and says so', async () => {
      const { checks } = await run({ apiUrl: API, webUrl: WEB });

      expect(byId(checks, 'cors-allowed')).toMatchObject({ status: 'pass' });
    });

    it('fails when the web is not allowed, and says which variable to fix', async () => {
      const { checks } = await run(
        { apiUrl: API, webUrl: WEB },
        { [`OPTIONS ${API}/v1/me origin=${WEB}`]: reply(204) },
      );

      expect(byId(checks, 'cors-allowed')).toMatchObject({ status: 'fail' });
      expect(byId(checks, 'cors-allowed').detail).toContain('CORS_ORIGINS');
    });

    it('fails when it answers for the wrong origin', async () => {
      const { checks } = await run(
        { apiUrl: API, webUrl: WEB },
        {
          [`OPTIONS ${API}/v1/me origin=${WEB}`]: reply(204, {
            headers: { 'access-control-allow-origin': 'https://otra.pages.dev' },
          }),
        },
      );

      expect(byId(checks, 'cors-allowed')).toMatchObject({ status: 'fail' });
    });

    it('lets in nobody else: a site that nobody named gets no permission, and never a wildcard', async () => {
      const { checks } = await run({ apiUrl: API, webUrl: WEB });

      expect(byId(checks, 'cors-closed')).toMatchObject({ status: 'pass' });
    });

    it.each(['*', 'https://sitio-ajeno.example'])(
      'fails when any site is allowed (%s)',
      async (allowed) => {
        const { checks } = await run(
          { apiUrl: API, webUrl: WEB },
          {
            [`OPTIONS ${API}/v1/me origin=https://sitio-ajeno.example`]: reply(204, {
              headers: { 'access-control-allow-origin': allowed },
            }),
          },
        );

        expect(byId(checks, 'cors-closed')).toMatchObject({ status: 'fail' });
      },
    );
  });
});

describe('the web', () => {
  it('serves the page of the application', async () => {
    const { checks } = await run({ apiUrl: API, webUrl: WEB });

    expect(byId(checks, 'web-index')).toMatchObject({ status: 'pass' });
  });

  it.each([
    ['a 404', reply(404)],
    [
      'something that is not the application',
      reply(200, { headers: { 'content-type': 'text/html' }, body: '<html>Parked</html>' }),
    ],
    [
      'a page that is not HTML',
      reply(200, { headers: { 'content-type': 'application/json' }, body: '<div id="root">' }),
    ],
  ])('fails when the first page is %s', async (_name, answer) => {
    const { checks } = await run({ apiUrl: API, webUrl: WEB }, { [`GET ${WEB}/`]: answer });

    expect(byId(checks, 'web-index')).toMatchObject({ status: 'fail' });
  });

  it('says the status when the first page is a 404, and not just that it is not the application', async () => {
    const { checks } = await run({ apiUrl: API, webUrl: WEB }, { [`GET ${WEB}/`]: reply(404) });

    expect(byId(checks, 'web-index').detail).toContain('404');
  });

  it('fails when a route of the application is not a page', async () => {
    const { checks } = await run(
      { apiUrl: API, webUrl: WEB },
      {
        [`GET ${WEB}/mostrador`]: reply(200, {
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      },
    );

    expect(byId(checks, 'web-routes')).toMatchObject({ status: 'fail' });
  });

  it('serves the application from any route, so that reloading on /mostrador does not give a 404', async () => {
    const { checks } = await run({ apiUrl: API, webUrl: WEB });

    expect(byId(checks, 'web-routes')).toMatchObject({ status: 'pass' });
  });

  it('fails when a route of the application is a 404', async () => {
    const { checks } = await run(
      { apiUrl: API, webUrl: WEB },
      { [`GET ${WEB}/mostrador`]: reply(404) },
    );

    expect(byId(checks, 'web-routes')).toMatchObject({ status: 'fail' });
  });

  describe('its service worker', () => {
    it('is served as a script and without a long cache, so that a new version is found', async () => {
      const { checks } = await run({ apiUrl: API, webUrl: WEB });

      expect(byId(checks, 'web-sw')).toMatchObject({ status: 'pass' });
    });

    it.each([
      ['it is a 404', reply(404)],
      [
        'it is not a script',
        reply(200, { headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } }),
      ],
      [
        'it is cached for a day',
        reply(200, {
          headers: { 'content-type': 'text/javascript', 'cache-control': 'public, max-age=86400' },
        }),
      ],
      ['it has no cache rule', reply(200, { headers: { 'content-type': 'text/javascript' } })],
    ])('fails when %s', async (_name, answer) => {
      const { checks } = await run({ apiUrl: API, webUrl: WEB }, { [`GET ${WEB}/sw.js`]: answer });

      expect(byId(checks, 'web-sw')).toMatchObject({ status: 'fail' });
    });

    it.each(['no-store', 'max-age=0', 'public, max-age=0, must-revalidate'])(
      'accepts %s as a cache rule that always asks again',
      async (rule) => {
        const { checks } = await run(
          { apiUrl: API, webUrl: WEB },
          {
            [`GET ${WEB}/sw.js`]: reply(200, {
              headers: { 'content-type': 'application/javascript', 'cache-control': rule },
            }),
          },
        );

        expect(byId(checks, 'web-sw')).toMatchObject({ status: 'pass' });
      },
    );
  });

  describe('its manifest and its files', () => {
    it('serves the manifest, with a name', async () => {
      const { checks } = await run({ apiUrl: API, webUrl: WEB });

      expect(byId(checks, 'web-manifest')).toMatchObject({ status: 'pass' });
    });

    it.each([
      ['a 404', reply(404)],
      ['something that is not JSON', reply(200, { body: '<html>' })],
      ['a manifest without a name', reply(200, { body: '{"short_name":"x"}' })],
      ['a manifest with an empty name', reply(200, { body: '{"name":""}' })],
      ['a manifest whose name is not text', reply(200, { body: '{"name":5}' })],
    ])('fails when the manifest is %s', async (_name, answer) => {
      const { checks } = await run(
        { apiUrl: API, webUrl: WEB },
        { [`GET ${WEB}/manifest.webmanifest`]: answer },
      );

      expect(byId(checks, 'web-manifest')).toMatchObject({ status: 'fail' });
    });

    it('serves the files with a hash in their name for a year: they never change', async () => {
      const { checks } = await run({ apiUrl: API, webUrl: WEB });

      expect(byId(checks, 'web-assets')).toMatchObject({ status: 'pass' });
      expect(byId(checks, 'web-assets').detail).toContain('/assets/index-abc.js');
    });

    it.each([
      ['public, max-age=31536000', 'pass'],
      ['max-age=31536001', 'pass'],
      ['public, immutable', 'pass'],
      ['max-age=31535999', 'sin caché larga'],
      ['public, max-age=1000', 'sin caché larga'],
      ['max-age=0', 'sin caché larga'],
    ])('judges the rule %s for the files', async (rule, word) => {
      const { checks } = await run(
        { apiUrl: API, webUrl: WEB },
        {
          [`GET ${WEB}/assets/index-abc.js`]: reply(200, {
            headers: { 'content-type': 'text/javascript', 'cache-control': rule },
          }),
        },
      );

      expect(byId(checks, 'web-assets').status).toBe('pass');
      if (word === 'pass')
        expect(byId(checks, 'web-assets').detail).not.toContain('sin caché larga');
      else expect(byId(checks, 'web-assets').detail).toContain(word);
    });

    it('fails when a file that the page asks for is not there', async () => {
      const { checks } = await run(
        { apiUrl: API, webUrl: WEB },
        { [`GET ${WEB}/assets/index-abc.js`]: reply(404) },
      );

      expect(byId(checks, 'web-assets')).toMatchObject({ status: 'fail' });
    });

    it('passes, saying what it costs, when the files are served without a long cache', async () => {
      const { checks } = await run(
        { apiUrl: API, webUrl: WEB },
        {
          [`GET ${WEB}/assets/index-abc.js`]: reply(200, {
            headers: { 'content-type': 'text/javascript' },
          }),
        },
      );

      expect(byId(checks, 'web-assets')).toMatchObject({ status: 'pass' });
      expect(byId(checks, 'web-assets').detail).toContain('sin caché larga');
    });

    it('skips the files when the page does not ask for any', async () => {
      const { checks } = await run(
        { apiUrl: API, webUrl: WEB },
        {
          [`GET ${WEB}/`]: reply(200, {
            headers: { 'content-type': 'text/html' },
            body: '<div id="root"></div>',
          }),
        },
      );

      expect(byId(checks, 'web-assets').status).toBe('skip');
    });
  });
});

describe('the report', () => {
  it('passes when everything is as it should be, and exits with zero', async () => {
    const { checks } = await run({ apiUrl: API, webUrl: WEB });

    expect(checks.filter((item) => item.status === 'fail')).toEqual([]);
    expect(exitCodeOf(checks)).toBe(0);
    expect(formatReport(checks)).toContain('0 fallan');
  });

  it('exits with one when anything fails', async () => {
    const { checks } = await run({ apiUrl: API }, { [`GET ${API}/v1/ready`]: reply(503) });

    expect(exitCodeOf(checks)).toBe(1);
  });

  it('never prints a long error in full either', async () => {
    const { checks } = await run(
      { apiUrl: API },
      { [`GET ${API}/health`]: new Error('x'.repeat(2_000)) },
    );

    expect(byId(checks, 'health').detail.length).toBeLessThan(400);
  });

  it('never prints what the hosts answered in full: only a short, one-line description', async () => {
    const { checks } = await run(
      { apiUrl: API },
      { [`GET ${API}/v1/ready`]: reply(503, { body: 'x'.repeat(5_000) }) },
    );

    expect(byId(checks, 'ready').detail.length).toBeLessThan(400);
  });
});
