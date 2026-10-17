import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { select } from './support/sql.js';
import { createAdminPool, withSettings } from './support/database.js';
import { BUSINESS_A, BUSINESS_B, resetData, seedBusiness } from './support/seed.js';

/**
 * Las dos politicas de la migracion de invitaciones (ADR 0023), probadas a mano con SQL y con el rol real de la
 * aplicacion: lo que una transaccion que solo conoce un hash puede ver y tomar, y lo que no.
 */
describe('the invitation policies against PostgreSQL (ADR 0023)', () => {
  let admin: pg.Pool;
  const FUTURE = '2099-01-01T00:00:00Z';
  const PAST = '2000-01-01T00:00:00Z';

  const invite = async (
    businessId: string,
    hash: string,
    overrides: { active?: boolean; expiresAt?: string; authUserId?: string | null } = {},
  ): Promise<string> => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO app_user (id, id_negocio, auth_user_id, full_name, role, active, invitation_hash, invitation_expires_at)
       VALUES ($1, $2, $3, 'Invitado', 'cashier', $4, $5, $6)`,
      [
        id,
        businessId,
        overrides.authUserId ?? null,
        overrides.active ?? true,
        hash,
        overrides.expiresAt ?? FUTURE,
      ],
    );
    return id;
  };

  beforeAll(() => {
    admin = createAdminPool(2);
  });

  beforeEach(async () => {
    await resetData(admin);
    await seedBusiness(admin, BUSINESS_A);
    await seedBusiness(admin, BUSINESS_B);
  });

  afterAll(async () => {
    await admin.end();
  });

  it('has exactly these four policies on the people table, so none is added by accident', async () => {
    const policies = await admin.query<{ policyname: string; cmd: string }>(
      "SELECT policyname, cmd FROM pg_policies WHERE tablename = 'app_user' ORDER BY policyname",
    );

    expect(policies.rows).toEqual([
      { policyname: 'business_isolation', cmd: 'ALL' },
      { policyname: 'identity_lookup', cmd: 'SELECT' },
      { policyname: 'invitation_lookup', cmd: 'SELECT' },
      { policyname: 'invitation_redeem', cmd: 'UPDATE' },
    ]);
  });

  it('keeps the hash unique in the whole database, not per business', async () => {
    await invite(BUSINESS_A, 'mismo-hash');

    await expect(invite(BUSINESS_B, 'mismo-hash')).rejects.toThrow(/app_user_invitation_hash_key/);
  });

  it('lets many people have no hash at all', async () => {
    await expect(
      admin.query(
        "INSERT INTO app_user (id_negocio, auth_user_id, full_name, role) SELECT $1, gen_random_uuid(), 'Persona ' || g, 'cashier' FROM generate_series(1, 3) g",
        [BUSINESS_A],
      ),
    ).resolves.toBeDefined();
  });

  describe('seeing', () => {
    it('shows the invitation of the hash the transaction knows, and nothing else', async () => {
      await invite(BUSINESS_A, 'hash-a');
      await invite(BUSINESS_B, 'hash-b');

      const rows = await withSettings(admin, { 'app.invitation_hash': 'hash-a' }, (client) =>
        client.query('SELECT invitation_hash, id_negocio FROM app_user'),
      );

      expect(rows.rows).toEqual([{ invitation_hash: 'hash-a', id_negocio: BUSINESS_A }]);
    });

    it('shows nothing to a transaction that knows no hash, or a wrong one', async () => {
      await invite(BUSINESS_A, 'hash-a');

      for (const settings of [
        {},
        { 'app.invitation_hash': '' },
        { 'app.invitation_hash': 'otro' },
      ]) {
        const rows = await withSettings(admin, settings, (client) =>
          client.query('SELECT id FROM app_user'),
        );
        expect(rows.rows).toEqual([]);
      }
    });

    it('does not show an invitation that already has an identity, even with its hash', async () => {
      await invite(BUSINESS_A, 'hash-a', { authUserId: randomUUID() });

      const rows = await withSettings(admin, { 'app.invitation_hash': 'hash-a' }, (client) =>
        client.query('SELECT id FROM app_user'),
      );

      expect(rows.rows).toEqual([]);
    });

    it('does not show the people who work in the business, only the invitation', async () => {
      await invite(BUSINESS_A, 'hash-a');

      const rows = await withSettings(admin, { 'app.invitation_hash': 'hash-a' }, (client) =>
        client.query<{ n: number }>("SELECT count(*)::int AS n FROM app_user WHERE role = 'owner'"),
      );

      expect(rows.rows[0]!.n).toBe(0);
    });

    it('does not remember the hash once the transaction ends', async () => {
      await invite(BUSINESS_A, 'hash-a');
      await withSettings(admin, { 'app.invitation_hash': 'hash-a' }, (client) =>
        client.query('SELECT id FROM app_user'),
      );

      const later = await withSettings(admin, {}, (client) =>
        client.query('SELECT id FROM app_user'),
      );

      expect(later.rows).toEqual([]);
    });
  });

  describe('taking', () => {
    const take = (settings: Record<string, string>, hash: string, authUserId: string) =>
      withSettings(admin, settings, (client) =>
        client.query(
          `UPDATE app_user SET auth_user_id = $2, invitation_hash = NULL, invitation_expires_at = NULL
           WHERE invitation_hash = $1 RETURNING id`,
          [hash, authUserId],
        ),
      );

    it('binds the invitation to the identity the transaction declared', async () => {
      const id = await invite(BUSINESS_A, 'hash-a');
      const sub = randomUUID();

      const result = await take(
        { 'app.invitation_hash': 'hash-a', 'app.auth_user_id': sub },
        'hash-a',
        sub,
      );

      expect(result.rows).toEqual([{ id }]);
      const row = (
        await select(admin, 'SELECT auth_user_id, invitation_hash FROM app_user WHERE id = $1', [
          id,
        ])
      )[0]!;
      expect(row).toEqual({ auth_user_id: sub, invitation_hash: null });
    });

    it('refuses to bind it to an identity other than the one declared', async () => {
      await invite(BUSINESS_A, 'hash-a');

      await expect(
        take(
          { 'app.invitation_hash': 'hash-a', 'app.auth_user_id': randomUUID() },
          'hash-a',
          randomUUID(),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('refuses to bind it to another identity even when nothing is read back', async () => {
      const id = await invite(BUSINESS_A, 'hash-a');

      // Sin RETURNING: lo unico que impide el cambio es la condicion WITH CHECK de la politica.
      await expect(
        withSettings(
          admin,
          { 'app.invitation_hash': 'hash-a', 'app.auth_user_id': randomUUID() },
          (client) =>
            client.query('UPDATE app_user SET auth_user_id = $2 WHERE invitation_hash = $1', [
              'hash-a',
              randomUUID(),
            ]),
        ),
      ).rejects.toThrow(/row-level security/);
      const row = (
        await select(admin, 'SELECT auth_user_id FROM app_user WHERE id = $1', [id])
      )[0]!;
      expect(row['auth_user_id']).toBeNull();
    });

    it('does not let the transaction change an invitation without binding it: no raising its own role', async () => {
      const id = await invite(BUSINESS_A, 'hash-a');

      // Sin ligar la identidad, la fila nueva no cumple la condicion WITH CHECK: la politica solo deja un resultado, la
      // invitacion canjeada por la identidad declarada.
      await expect(
        withSettings(
          admin,
          { 'app.invitation_hash': 'hash-a', 'app.auth_user_id': randomUUID() },
          (client) =>
            client.query("UPDATE app_user SET role = 'owner' WHERE invitation_hash = $1", [
              'hash-a',
            ]),
        ),
      ).rejects.toThrow(/row-level security/);
      const row = (await select(admin, 'SELECT role FROM app_user WHERE id = $1', [id]))[0]!;
      expect(row['role']).toBe('cashier');
    });

    it('refuses to bind it when no identity was declared', async () => {
      await invite(BUSINESS_A, 'hash-a');

      await expect(
        take({ 'app.invitation_hash': 'hash-a' }, 'hash-a', randomUUID()),
      ).rejects.toThrow(/row-level security/);
    });

    it('takes nothing without the hash, even knowing the invitation exists', async () => {
      const id = await invite(BUSINESS_A, 'hash-a');
      const sub = randomUUID();

      const result = await take({ 'app.auth_user_id': sub }, 'hash-a', sub);

      expect(result.rowCount).toBe(0);
      expect(
        (await select(admin, 'SELECT auth_user_id FROM app_user WHERE id = $1', [id]))[0]!
          .auth_user_id,
      ).toBeNull();
    });

    it('does not take an expired invitation', async () => {
      await invite(BUSINESS_A, 'hash-a', { expiresAt: PAST });
      const sub = randomUUID();

      const result = await take(
        { 'app.invitation_hash': 'hash-a', 'app.auth_user_id': sub },
        'hash-a',
        sub,
      );

      expect(result.rowCount).toBe(0);
    });

    it('does not take a revoked invitation', async () => {
      await invite(BUSINESS_A, 'hash-a', { active: false });
      const sub = randomUUID();

      const result = await take(
        { 'app.invitation_hash': 'hash-a', 'app.auth_user_id': sub },
        'hash-a',
        sub,
      );

      expect(result.rowCount).toBe(0);
    });

    it('does not take a different invitation than the one whose hash it knows', async () => {
      await invite(BUSINESS_A, 'hash-a');
      const other = await invite(BUSINESS_B, 'hash-b');
      const sub = randomUUID();

      const result = await take(
        { 'app.invitation_hash': 'hash-a', 'app.auth_user_id': sub },
        'hash-b',
        sub,
      );

      expect(result.rowCount).toBe(0);
      expect(
        (await select(admin, 'SELECT auth_user_id FROM app_user WHERE id = $1', [other]))[0]!
          .auth_user_id,
      ).toBeNull();
    });

    it('does not let the transaction rewrite a person who works in the business', async () => {
      await invite(BUSINESS_A, 'hash-a');
      const owners = await select(
        admin,
        "SELECT id FROM app_user WHERE role = 'owner' AND id_negocio = $1",
        [BUSINESS_A],
      );

      const result = await withSettings(
        admin,
        { 'app.invitation_hash': 'hash-a', 'app.auth_user_id': randomUUID() },
        (client) =>
          client.query('UPDATE app_user SET full_name = $2 WHERE id = $1', [
            owners[0]!['id'],
            'Pirata',
          ]),
      );

      expect(result.rowCount).toBe(0);
    });
  });
});
