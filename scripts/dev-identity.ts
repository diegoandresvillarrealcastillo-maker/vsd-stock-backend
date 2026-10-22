import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

/**
 * Un servicio de identidad de MENTIRA para probar la aplicacion completa en tu maquina, sin un proyecto de Supabase:
 * habla como Supabase Auth (GoTrue) en lo unico que usan el frontend y la API. Publica las claves publicas, entra con
 * correo y clave, registra, renueva y sale. Las personas viven en memoria y se pierden al apagarlo.
 *
 * SOLO para desarrollo: no valida correos, acepta cualquier clave de 6 o mas caracteres y escucha solo en 127.0.0.1.
 * La prueba contra el proyecto real es `npm run verify:pre` (ADR 0025).
 *
 * Uso: `npm run dev:identity` (puerto 54321, o el que pases en `--port`). Con `--confirm-email` el registro no entrega
 * sesion, como un proyecto que pide confirmar el correo.
 */

const AUDIENCE = 'authenticated';
const TOKEN_LIFETIME_SECONDS = 3600;
const MIN_PASSWORD_LENGTH = 6;

interface Person {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const port = Number(argValue('--port') ?? 54321);
const confirmEmail = process.argv.includes('--confirm-email');
const origin = `http://127.0.0.1:${port}`;
const issuer = `${origin}/auth/v1`;

const { privateKey, publicKey } = await generateKeyPair('ES256');
const publicJwk = { ...(await exportJWK(publicKey)), kid: 'dev-key', alg: 'ES256', use: 'sig' };

const people = new Map<string, Person>();
/** Token de renovacion -> persona. Se gasta con cada uso, como el de Supabase. */
const refreshTokens = new Map<string, string>();

async function sessionOf(person: Person): Promise<Record<string, unknown>> {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = await new SignJWT({
    email: person.email,
    role: 'authenticated',
    aal: 'aal1',
    session_id: randomUUID(),
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'dev-key' })
    .setIssuer(issuer)
    .setAudience(AUDIENCE)
    .setSubject(person.id)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_LIFETIME_SECONDS)
    .sign(privateKey);
  const refreshToken = randomUUID();
  refreshTokens.set(refreshToken, person.id);
  return {
    access_token: accessToken,
    token_type: 'bearer',
    expires_in: TOKEN_LIFETIME_SECONDS,
    expires_at: now + TOKEN_LIFETIME_SECONDS,
    refresh_token: refreshToken,
    user: { id: person.id, email: person.email },
  };
}

function cors(request: IncomingMessage, response: ServerResponse): void {
  const requestOrigin = request.headers.origin;
  // Solo paginas de esta maquina: es un servicio de juguete.
  if (
    typeof requestOrigin === 'string' &&
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(requestOrigin)
  ) {
    response.setHeader('Access-Control-Allow-Origin', requestOrigin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader(
    'Access-Control-Allow-Headers',
    'apikey, authorization, content-type, x-client-info',
  );
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

function problem(response: ServerResponse, status: number, code: string, message: string): void {
  send(response, status, { code: status, error_code: code, msg: message });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const server = createServer((request, response) => {
  void (async () => {
    cors(request, response);
    if (request.method === 'OPTIONS') return send(response, 204);
    const url = new URL(request.url ?? '/', origin);

    if (request.method === 'GET' && url.pathname === '/auth/v1/.well-known/jwks.json') {
      return send(response, 200, { keys: [publicJwk] });
    }
    if (request.method !== 'POST') return send(response, 404);

    if (url.pathname === '/auth/v1/token') {
      const body = await readJson(request);
      if (url.searchParams.get('grant_type') === 'password') {
        const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
        const person = people.get(email);
        if (person === undefined || person.password !== body['password']) {
          return problem(response, 400, 'invalid_credentials', 'Invalid login credentials');
        }
        return send(response, 200, await sessionOf(person));
      }
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const token = typeof body['refresh_token'] === 'string' ? body['refresh_token'] : '';
        const id = refreshTokens.get(token);
        const person = [...people.values()].find((candidate) => candidate.id === id);
        if (person === undefined) {
          return problem(response, 400, 'refresh_token_not_found', 'Invalid Refresh Token');
        }
        refreshTokens.delete(token);
        return send(response, 200, await sessionOf(person));
      }
      return problem(response, 400, 'validation_failed', 'Unsupported grant_type');
    }

    if (url.pathname === '/auth/v1/signup') {
      const body = await readJson(request);
      const email = typeof body['email'] === 'string' ? body['email'].trim().toLowerCase() : '';
      const password = typeof body['password'] === 'string' ? body['password'] : '';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return problem(response, 400, 'email_address_invalid', 'Email address is invalid');
      }
      if (password.length < MIN_PASSWORD_LENGTH) {
        return problem(response, 422, 'weak_password', 'Password should be at least 6 characters');
      }
      if (people.has(email)) {
        return problem(response, 422, 'user_already_exists', 'User already registered');
      }
      const person: Person = { id: randomUUID(), email, password };
      people.set(email, person);
      // Pidiendo confirmar el correo no hay sesion: solo se devuelve a la persona creada.
      return send(response, 200, confirmEmail ? { id: person.id, email } : await sessionOf(person));
    }

    if (url.pathname === '/auth/v1/logout') return send(response, 204);
    return send(response, 404);
  })();
});

server.listen(port, '127.0.0.1', () => {
  console.log(
    `Servicio de identidad de mentira en ${issuer}${confirmEmail ? ' (pide confirmar el correo)' : ''}`,
  );
  console.log('');
  console.log('En el .env de la API (vsd-stock-backend):');
  console.log(`  AUTH_ISSUER=${issuer}`);
  console.log(`  AUTH_JWKS_URL=${issuer}/.well-known/jwks.json`);
  console.log(`  AUTH_AUDIENCE=${AUDIENCE}`);
  console.log('En el .env.local del frontend (vsd-stock-frontend):');
  console.log(`  VITE_AUTH_URL=${issuer}`);
  console.log('  VITE_AUTH_PUBLISHABLE_KEY=sb_publishable_desarrollo_local');
});
