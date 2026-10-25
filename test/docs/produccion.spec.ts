import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// `docs/produccion.md` es lo que una persona lee para crear producción de verdad, que hoy no existe (PROD está en pausa). Aquí se vigila que
// no se quede atrás del código (las migraciones, las variables, los comandos), que no lleve ningún secreto y que diga lo que hay que decidir
// antes de levantar la pausa: el documento no la levanta.

const ROOT = resolve(import.meta.dirname, '../..');
const PATH = join(ROOT, 'docs', 'produccion.md');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const guide = existsSync(PATH) ? readFileSync(PATH, 'utf8').replaceAll('\r\n', '\n') : '';

const migrations = readdirSync(join(ROOT, 'prisma/migrations'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;

/** Las variables que el panel de la API pide: las de `render.yaml`. */
const apiVariables = [...read('render.yaml').matchAll(/^\s*-\s*key:\s*(\S+)\s*$/gm)].map(
  (match) => match[1] ?? '',
);

describe('docs/produccion.md', () => {
  it('exists, and the index of the documentation and the plan of environments link to it', () => {
    expect(existsSync(PATH)).toBe(true);
    expect(read('docs/README.md')).toContain('(produccion.md)');
    expect(read('docs/ambientes.md')).toContain('(produccion.md)');
  });

  it('says that it does not lift the pause of PROD, and what the owner has to decide in writing before doing anything', () => {
    expect(guide).toMatch(/no levanta la pausa/i);
    expect(guide).toMatch(/por escrito/i);
    for (const topic of [/copias de seguridad/i, /incidente/i, /datos de los negocios/i]) {
      expect(guide).toMatch(topic);
    }
  });

  it('says that the free plan of the API is not acceptable in PROD because it sleeps (ADR 0031)', () => {
    expect(guide).toContain('ADR 0031');
    expect(guide).toMatch(/no se duerm/i);
  });

  it('names the 7 migrations by their folder, in order, and says they are applied by a person and never by the assistant', () => {
    expect(migrations).toHaveLength(7);
    let last = -1;
    for (const name of migrations) {
      const at = guide.indexOf(name);
      expect(at, name).toBeGreaterThan(last);
      last = at;
    }
    expect(guide).toMatch(/una persona/i);
    expect(guide).toMatch(/nunca (Claude|el asistente)/i);
  });

  it('gives the commands of the migration and of the checks, and every `npm run` it names exists in package.json', () => {
    expect(guide).toContain('npm run db:migrate');
    expect(guide).toContain('npm run verify:deploy -- https://');
    expect(guide).toMatch(/node --env-file=\.env\.prod scripts\/verify-pre\.ts/);
    const named = [
      ...new Set([...guide.matchAll(/npm run ([a-z0-9:-]+)/g)].map((m) => m[1] ?? '')),
    ];
    const frontendOnly = ['publish:sitio', 'verify:sitio', 'build:sitio'];
    for (const name of named.filter((item) => !frontendOnly.includes(item))) {
      expect(Object.keys(scripts), name).toContain(name);
    }
  });

  it('names every variable that the panel of the API asks for, and says that the owner connection never goes to the API', () => {
    for (const key of apiVariables) expect(guide, key).toContain(`\`${key}\``);
    expect(guide).toContain('`DATABASE_MIGRATION_URL`');
    expect(guide).toMatch(/DATABASE_MIGRATION_URL`[^.]*(nunca|jamás)[^.]*(API|Render)/i);
  });

  it('puts the three variables of the web, and says that nothing compiled into the web is a secret', () => {
    for (const key of ['VITE_API_URL', 'VITE_AUTH_URL', 'VITE_AUTH_PUBLISHABLE_KEY']) {
      expect(guide, key).toContain(key);
    }
    expect(guide).toMatch(/sb_publishable_/);
    expect(guide).not.toMatch(/sb_secret_[A-Za-z0-9]/);
  });

  it('deploys the web with wrangler pages deploy and never with wrangler deploy, from the branch produccion', () => {
    expect(guide).toMatch(/wrangler pages deploy dist --project-name \S+ --branch produccion/);
    expect(guide).toMatch(
      /wrangler pages project create \S+ --production-branch produccion --force/,
    );
    expect(guide).toMatch(/No uses `wrangler deploy`/);
  });

  it('says that --produccion is the flag of the landing and not of the web of the application, and that the list of pending things can stop it', () => {
    expect(guide).toContain('npm run publish:sitio -- --produccion');
    expect(guide).toMatch(/--produccion[^.]*landing[^.]*no[^.]*aplicaci[óo]n/i);
    expect(guide).toContain('PENDIENTES_DE_PUBLICAR');
  });

  it('says that the migration of folio_de_anulaciones turns a trigger off for a moment, and how to check that it is on again', () => {
    expect(guide).toContain('20261023130000_folio_de_anulaciones');
    expect(guide).toContain('refuse_history_change');
    expect(guide).toMatch(/relforcerowsecurity/i);
  });

  it('names what the repository does not do for PROD yet: the rate limit that the ADR 0023 left for before production', () => {
    expect(guide).toContain('ADR 0023');
    expect(guide).toMatch(/l[ií]mite de (tasa|intentos)/i);
  });

  it('has no secret in it: no real connection string, no key, and every example password is a placeholder', () => {
    const connections = [...guide.matchAll(/postgres(?:ql)?:\/\/[^\s'"`)]+/g)].map((m) => m[0]);
    expect(connections.length).toBeGreaterThan(0);
    for (const connection of connections) {
      const password = /^postgres(?:ql)?:\/\/[^:]+:([^@]*)@/.exec(connection)?.[1];
      expect(password, connection).toMatch(/^[A-Z_]+$/);
    }
    expect(guide).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);
    expect(guide).not.toMatch(/sb_secret_/);
    expect(guide).toMatch(/nunca en un chat/i);
  });
});
