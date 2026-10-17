import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  UserInactiveError,
  type Authenticate,
  type Session,
} from '../../../domain/ports/in/authenticate.js';
import type { GetMe, MeView } from '../../../domain/ports/in/get-me.js';
import { MeController } from './me.controller.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { AUTHENTICATE, GET_ME } from './tokens.js';

const identity = {
  subject: '9b2f6c1e-0d5a-4c1b-8f3e-2a7d6e5c4b3a',
  email: 'ana@example.com',
  expiresAt: new Date('2026-10-17T16:00:00.000Z'),
};

const view: MeView = {
  identity: { id: identity.subject, email: 'ana@example.com' },
  membership: {
    userId: '11111111-1111-4111-8111-111111111111',
    businessId: '22222222-2222-4222-8222-222222222222',
    businessName: 'Tienda La Esquina',
    role: 'owner',
    fullName: 'Ana Gómez',
  },
};

describe('GET /v1/me', () => {
  let app: NestExpressApplication;
  let baseUrl: string;
  /** Lo que recibio el doble del puerto de entrada, para comprobar que el controlador lo usa bien. */
  let authorizationSeen: (string | undefined)[];
  let sessionSeen: Session[];
  let authenticate: Authenticate;
  let getMe: GetMe;

  beforeEach(async () => {
    authorizationSeen = [];
    sessionSeen = [];
    authenticate = {
      execute: (header) => {
        authorizationSeen.push(header);
        return Promise.resolve({ identity, membership: null });
      },
    };
    getMe = {
      execute: (session) => {
        sessionSeen.push(session);
        return Promise.resolve(view);
      },
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [MeController],
      providers: [
        { provide: AUTHENTICATE, useValue: authenticate },
        { provide: GET_ME, useValue: getMe },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await app.close();
  });

  it('answers who the person is, from the session the guard found', async () => {
    const response = await fetch(`${baseUrl}/v1/me`, { headers: { Authorization: 'Bearer t' } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(view);
    expect(sessionSeen).toEqual([{ identity, membership: null }]);
  });

  it('hands the Authorization header, exactly as it came, to the authentication use case', async () => {
    await fetch(`${baseUrl}/v1/me`, { headers: { Authorization: 'Bearer abc.def.ghi' } });

    expect(authorizationSeen).toEqual(['Bearer abc.def.ghi']);
  });

  it('answers 401 when the authentication use case says there are no credentials, and never asks who is calling', async () => {
    authenticate = {
      execute: () => Promise.reject(new AuthenticationError('missing')),
    };
    await app.close();
    const moduleRef = await Test.createTestingModule({
      controllers: [MeController],
      providers: [
        { provide: AUTHENTICATE, useValue: authenticate },
        { provide: GET_ME, useValue: getMe },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/v1/me`);

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'unauthenticated' });
    expect(sessionSeen).toEqual([]);
  });

  it('answers 403 when the person was deactivated', async () => {
    getMe = {
      execute: () => Promise.reject(new UserInactiveError()),
    };
    await app.close();
    const moduleRef = await Test.createTestingModule({
      controllers: [MeController],
      providers: [
        { provide: AUTHENTICATE, useValue: authenticate },
        { provide: GET_ME, useValue: getMe },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false });
    app.useGlobalFilters(new ProblemDetailsFilter());
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/v1/me`, {
      headers: { Authorization: 'Bearer t' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'user-inactive' });
  });
});
