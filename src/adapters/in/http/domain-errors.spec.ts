import type { AddressInfo } from 'node:net';
import { Controller, Get, Param } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseNotConfiguredError } from '../../../domain/model/database-not-configured-error.js';
import {
  AuthenticationError,
  UserInactiveError,
  type AuthenticationFailure,
} from '../../../domain/ports/in/authenticate.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import type { Problem } from './problem-details.js';

// Un controlador de mentira que lanza los errores del DOMINIO, como lo haran los casos de uso de verdad: el filtro los
// traduce una sola vez para que ningun endpoint tenga que acordarse de hacerlo.
@Controller('fail')
class FailController {
  @Get('auth/:reason')
  auth(@Param('reason') reason: string): never {
    throw new AuthenticationError(reason as AuthenticationFailure);
  }

  @Get('inactive')
  inactive(): never {
    throw new UserInactiveError();
  }

  @Get('database')
  database(): never {
    throw new DatabaseNotConfiguredError();
  }

  @Get('plain')
  plain(): never {
    throw new Error('la clave es secreto123');
  }
}

describe('domain errors as problem+json', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [FailController] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  const get = async (path: string) => {
    const response = await fetch(`${baseUrl}${path}`);
    return { response, problem: (await response.json()) as Problem };
  };

  describe('a caller that cannot be authenticated', () => {
    it.each(['missing', 'scheme'])(
      'asks for credentials when there are none or they are not a bearer (%s)',
      async (reason) => {
        const { response, problem } = await get(`/fail/auth/${reason}`);

        expect(response.status).toBe(401);
        expect(problem.code).toBe('unauthenticated');
        expect(response.headers.get('www-authenticate')).toBe('Bearer');
      },
    );

    it('tells the client that the token expired, so that it renews it instead of asking for the password', async () => {
      const { response, problem } = await get('/fail/auth/expired');

      expect(response.status).toBe(401);
      expect(problem.code).toBe('token-expired');
      expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    });

    const invalid: AuthenticationFailure[] = [
      'malformed',
      'signature',
      'algorithm',
      'not-yet-valid',
      'issuer',
      'audience',
      'role',
      'claims',
    ];

    it.each(invalid)('answers the same invalid-token to a token refused for %s', async (reason) => {
      const { response, problem } = await get(`/fail/auth/${reason}`);

      expect(response.status).toBe(401);
      expect(problem.code).toBe('invalid-token');
      expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
    });

    it('never says why a token was refused: the message is the same for every reason, so it teaches nobody how to forge one', async () => {
      const details = new Set<string>();
      for (const reason of invalid) details.add((await get(`/fail/auth/${reason}`)).problem.detail);

      expect(details.size).toBe(1);
      for (const reason of invalid) expect([...details][0]).not.toContain(reason);
    });

    it('says the identity service is unavailable, and to try again in a few seconds', async () => {
      const { response, problem } = await get('/fail/auth/unavailable');

      expect(response.status).toBe(503);
      expect(problem.code).toBe('identity-unavailable');
      expect(response.headers.get('retry-after')).toBe('5');
    });

    it('says the identity service was never configured', async () => {
      const { response, problem } = await get('/fail/auth/not-configured');

      expect(response.status).toBe(503);
      expect(problem.code).toBe('identity-not-configured');
    });
  });

  describe('what is said to the person', () => {
    it.each([
      ['missing', 'Hace falta iniciar sesión'],
      ['expired', 'La sesión venció'],
      ['signature', 'El token no es válido'],
      ['unavailable', 'No se pudo comprobar la sesión'],
      ['not-configured', 'El servicio de identidad no está configurado'],
    ])('explains a %s failure in words the person can read', async (reason, words) => {
      const { problem } = await get(`/fail/auth/${reason}`);

      expect(problem.detail).toContain(words);
    });

    it('explains a deactivated person and a missing database in words too', async () => {
      expect((await get('/fail/inactive')).problem.detail).toContain('dada de baja');
      expect((await get('/fail/database')).problem.detail).toContain('no está configurada');
    });
  });

  it('answers 403 to a person who was deactivated, with a code of its own', async () => {
    const { response, problem } = await get('/fail/inactive');

    expect(response.status).toBe(403);
    expect(problem.code).toBe('user-inactive');
  });

  it('answers 503 when something needs the database and it was never configured', async () => {
    const { response, problem } = await get('/fail/database');

    expect(response.status).toBe(503);
    expect(problem.code).toBe('database-not-configured');
  });

  it('still hides the cause of any other failure', async () => {
    const { response, problem } = await get('/fail/plain');

    expect(response.status).toBe(500);
    expect(JSON.stringify(problem)).not.toContain('secreto123');
  });
});
