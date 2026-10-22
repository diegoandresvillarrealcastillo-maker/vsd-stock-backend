import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// El despliegue de PRE se describe en `render.yaml` (ADR 0031) y no lleva NINGUN secreto: lo que lleva contrasena o una clave se
// pide en el panel al crear el servicio (`sync: false`). Estas pruebas vigilan lo que se puede comprobar sin leer el panel: que el
// archivo diga lo que el ADR decidio, que ninguna variable secreta tenga su valor escrito y que la API de PRE nunca reciba el rol
// duenio de las tablas.

const ROOT = resolve(import.meta.dirname, '../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const blueprint = read('render.yaml');

interface EnvVar {
  readonly key: string;
  readonly value: string | null;
  readonly sync: boolean | null;
}

/** Las variables del servicio, leidas del bloque `envVars` (un arreglo de `key` con `value` o `sync`). */
function envVars(source: string): EnvVar[] {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => /^\s*envVars:\s*$/.test(line));
  if (start < 0) return [];
  const found: EnvVar[] = [];
  let current: { key: string; value: string | null; sync: boolean | null } | null = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const key = /^\s*-\s*key:\s*(\S+)\s*$/.exec(line);
    if (key?.[1] !== undefined) {
      if (current !== null) found.push(current);
      current = { key: key[1], value: null, sync: null };
      continue;
    }
    const value = /^\s+value:\s*(.*?)\s*$/.exec(line);
    if (value?.[1] !== undefined && current !== null)
      current.value = value[1].replace(/^["']|["']$/g, '');
    const sync = /^\s+sync:\s*(true|false)\s*$/.exec(line);
    if (sync?.[1] !== undefined && current !== null) current.sync = sync[1] === 'true';
  }
  if (current !== null) found.push(current);
  return found;
}

const field = (name: string): string | undefined =>
  new RegExp(`^\\s{4}${name}:\\s*(.+?)\\s*$`, 'm').exec(blueprint)?.[1];

describe('render.yaml: the API of PRE', () => {
  it('is one web service that runs the Docker image of the backend (ADR 0011)', () => {
    expect(blueprint).toMatch(/^services:\s*$/m);
    expect(blueprint.match(/^\s*-\s*type:\s*(\S+)/gm)).toEqual(['  - type: web']);
    expect(field('runtime')).toBe('docker');
    expect(field('dockerfilePath')).toBe('./Dockerfile');
    expect(field('dockerContext')).toBe('.');
  });

  it('is the free plan, which is what PRE is (and what that costs is in the ADR)', () => {
    expect(field('plan')).toBe('free');
  });

  it('is called as PRE says, so that it can not be mistaken for another environment', () => {
    expect(field('name')).toBe('vsd-stock-api-pre');
  });

  it('is deployed from the branch of PRE, so that nothing reaches it until a promotion (ADR 0010)', () => {
    expect(field('branch')).toBe('preproduccion');
    expect(field('autoDeployTrigger')).toBe('commit');
  });

  it('checks its health with GET /health, which does not touch the database', () => {
    expect(field('healthCheckPath')).toBe('/health');
  });

  it('lives in the same region as the Supabase project of PRE, so that the database is close', () => {
    expect(field('region')).toBe('virginia');
  });
});

describe('render.yaml: its variables', () => {
  const variables = envVars(blueprint);
  const names = variables.map((variable) => variable.key);

  it('has no secret written in the file: whatever carries a password or a key is asked for in the panel', () => {
    const secret = variables.filter((variable) =>
      /URL|SECRET|PASSWORD|TOKEN|KEY|ORIGINS/.test(variable.key),
    );

    expect(secret.length).toBeGreaterThan(0);
    for (const variable of secret) {
      expect(variable.sync, variable.key).toBe(false);
      expect(variable.value, variable.key).toBeNull();
    }
  });

  it('asks in the panel for what is specific to PRE: the database, the web that may read its answers and the identity service', () => {
    for (const name of ['DATABASE_URL', 'CORS_ORIGINS', 'AUTH_ISSUER', 'AUTH_JWKS_URL']) {
      expect(names).toContain(name);
    }
  });

  it('writes only what is public and the same in every environment', () => {
    const literal = variables.filter((variable) => variable.value !== null);

    expect(Object.fromEntries(literal.map((variable) => [variable.key, variable.value]))).toEqual({
      AUTH_AUDIENCE: 'authenticated',
    });
  });

  it('never gives the API the connection of the owner of the tables: it only migrates, by hand, from a person machine (ADR 0021)', () => {
    expect(names).not.toContain('DATABASE_MIGRATION_URL');
    expect(blueprint).not.toContain('DATABASE_MIGRATION_URL');
  });

  it('does not set PORT: the host gives it, and the API listens where it is told', () => {
    expect(names).not.toContain('PORT');
  });

  it('declares only variables that the API reads and that .env.example explains', () => {
    const example = read('.env.example');

    for (const name of names) {
      expect(example, name).toMatch(new RegExp(`^#? ?${name}=`, 'm'));
    }
  });
});

describe('the steps for PRE (docs/ambientes.md)', () => {
  const guide = read('docs/ambientes.md');

  it('say how to create each host and what to check afterwards', () => {
    expect(guide).toContain('## Crear los hosts de PRE');
    expect(guide).toContain('render.yaml');
    expect(guide).toContain('Cloudflare Pages');
    expect(guide).toContain('npm run verify:deploy');
  });

  it('name every variable that the panel asks for', () => {
    for (const variable of envVars(blueprint).filter((item) => item.sync === false)) {
      expect(guide, variable.key).toContain(variable.key);
    }
  });

  it('say what the free plan costs: it sleeps, and how long it takes to wake', () => {
    expect(guide).toMatch(/15 minutos/);
    expect(guide).toMatch(/dormida|duerme/);
  });

  it('say that the secrets are never pasted in a chat, in the very section that asks for them', () => {
    const section = guide.slice(guide.indexOf('## Crear los hosts de PRE'));

    expect(section).toContain('Los secretos no se pegan en ningún chat');
  });

  it('give the command that checks the hosts, ready to copy', () => {
    expect(guide).toMatch(/```bash\nnpm run verify:deploy -- https:\/\/\S+ https:\/\/\S+\n```/);
  });
});
