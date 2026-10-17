import type { AddressInfo } from 'node:net';
import {
  BadRequestException,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROBLEM_CONTENT_TYPE, type Problem } from './problem-details.js';
import { ApiProblem, ProblemDetailsFilter } from './problem-details.filter.js';
import { requestIdMiddleware } from './request-id.js';

// Un controlador de mentira que falla de todas las maneras en que puede fallar uno de verdad.
@Controller('boom')
class BoomController {
  @Get('not-found')
  notFound(): never {
    throw new NotFoundException('No existe el producto');
  }

  @Get('bad-request')
  badRequest(): never {
    throw new BadRequestException('La petición no es válida');
  }

  @Get('unauthorized')
  unauthorized(): never {
    throw new UnauthorizedException();
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException();
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictException();
  }

  @Get('teapot')
  teapot(): never {
    throw new HttpException('soy una tetera', 418);
  }

  @Get('case')
  caseWithOwnCode(): never {
    throw new ApiProblem(409, 'shift-closed', 'El turno ya estaba cerrado');
  }

  @Get('invalid')
  invalid(): never {
    throw new ApiProblem(400, 'validation-failed', 'Hay campos inválidos', {
      errors: [
        { pointer: '/lines/0/quantityMilli', code: 'out-of-range', detail: 'Debe ser positivo' },
      ],
    });
  }

  @Get('slow-down')
  slowDown(): never {
    throw new ApiProblem(429, 'rate-limited', 'Demasiadas peticiones', { retryAfterSeconds: 7 });
  }

  @Get('unavailable')
  unavailable(): never {
    throw new ApiProblem(503, 'database-unavailable', 'La base no responde', {
      retryAfterSeconds: 30,
    });
  }

  @Get('crash')
  crash(): never {
    throw new Error(
      'connect ECONNREFUSED 10.0.0.5:5432: password authentication failed for user stock',
    );
  }

  @Get('http-500')
  http500(): never {
    throw new InternalServerErrorException(
      'fallo la conexion a 10.0.0.5 con la clave del usuario stock',
    );
  }

  @Get('throws-text')
  throwsText(): never {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- justamente el caso que se prueba
    throw 'un texto suelto';
  }
}

describe('ProblemDetailsFilter (ADR 0019)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ controllers: [BoomController] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.use(requestIdMiddleware);
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${baseUrl}${path}`, { headers });
    return { response, problem: (await response.json()) as Problem };
  };

  it('answers every error with application/problem+json', async () => {
    for (const path of ['/boom/not-found', '/boom/crash', '/does-not-exist']) {
      const { response } = await get(path);

      expect(response.headers.get('content-type'), path).toContain(PROBLEM_CONTENT_TYPE);
    }
  });

  it.each([
    ['/boom/not-found', 404, 'not-found'],
    ['/boom/bad-request', 400, 'validation-failed'],
    ['/boom/unauthorized', 401, 'unauthenticated'],
    ['/boom/forbidden', 403, 'forbidden'],
    ['/boom/conflict', 409, 'conflict'],
    ['/boom/teapot', 418, 'client-error'],
    ['/does-not-exist', 404, 'not-found'],
  ])('turns %s into a %i problem with the code "%s"', async (path, status, code) => {
    const { response, problem } = await get(path);

    expect(response.status).toBe(status);
    expect(problem.status).toBe(status);
    expect(problem.code).toBe(code);
    expect(problem.type).toBe(`urn:vsd-stock:problem:${code}`);
    expect(problem.title.length).toBeGreaterThan(0);
  });

  it('says what the application said for a known error', async () => {
    const { problem } = await get('/boom/not-found');

    expect(problem.detail).toBe('No existe el producto');
  });

  it('names the route in "instance" and never its query string', async () => {
    const { problem } = await get('/boom/not-found?phone=3001234567');

    expect(problem.instance).toBe('/boom/not-found');
  });

  it('lets a case bring its own stable code', async () => {
    const { response, problem } = await get('/boom/case');

    expect(response.status).toBe(409);
    expect(problem.code).toBe('shift-closed');
    expect(problem.type).toBe('urn:vsd-stock:problem:shift-closed');
    expect(problem.detail).toBe('El turno ya estaba cerrado');
  });

  it('lists the invalid fields with their JSON pointer', async () => {
    const { problem } = await get('/boom/invalid');

    expect(problem.errors).toEqual([
      { pointer: '/lines/0/quantityMilli', code: 'out-of-range', detail: 'Debe ser positivo' },
    ]);
  });

  it('tells the client how long to wait with Retry-After, in seconds', async () => {
    const slowDown = await get('/boom/slow-down');
    const unavailable = await get('/boom/unavailable');

    expect(slowDown.response.status).toBe(429);
    expect(slowDown.response.headers.get('retry-after')).toBe('7');
    expect(unavailable.response.status).toBe(503);
    expect(unavailable.response.headers.get('retry-after')).toBe('30');
    expect(unavailable.problem.code).toBe('database-unavailable');
  });

  it('does not send Retry-After when nobody asked for it', async () => {
    const { response } = await get('/boom/conflict');

    expect(response.headers.get('retry-after')).toBeNull();
  });

  it('hides the reason of an unexpected failure, because it may carry a host or a password', async () => {
    const { response, problem } = await get('/boom/crash');
    const text = JSON.stringify(problem);

    expect(response.status).toBe(500);
    expect(problem.code).toBe('internal-error');
    expect(text).not.toContain('ECONNREFUSED');
    expect(text).not.toContain('password');
    expect(text).not.toContain('10.0.0.5');
    expect(text).not.toContain('stack');
  });

  it('hides the message of a 500 that Nest itself raised, as it hides the one of an unknown error', async () => {
    const { response, problem } = await get('/boom/http-500');
    const text = JSON.stringify(problem);

    expect(response.status).toBe(500);
    expect(problem.code).toBe('internal-error');
    expect(text).not.toContain('10.0.0.5');
    expect(text).not.toContain('clave');
  });

  it('survives something that is not an Error at all', async () => {
    const { response, problem } = await get('/boom/throws-text');

    expect(response.status).toBe(500);
    expect(problem.code).toBe('internal-error');
  });

  it('puts in "traceId" the same identifier the response carries in X-Request-Id, so that a report finds the log', async () => {
    const { response, problem } = await get('/boom/crash', {
      'X-Request-Id': 'device-request-0001',
    });

    expect(response.headers.get('x-request-id')).toBe('device-request-0001');
    expect(problem.traceId).toBe('device-request-0001');
  });

  it('gives a traceId even when the caller sent no identifier', async () => {
    const { response, problem } = await get('/boom/not-found');

    expect(problem.traceId.length).toBeGreaterThanOrEqual(8);
    expect(response.headers.get('x-request-id')).toBe(problem.traceId);
  });
});
