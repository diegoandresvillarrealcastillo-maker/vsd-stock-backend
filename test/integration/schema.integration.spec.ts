import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_ROLE, asApplication, asIdentity, createAdminPool } from './support/database.js';
import { MAX_PESOS } from '../../src/domain/model/money.js';
import { ROLES } from '../../src/domain/model/role.js';
import { MAX_QUANTITY_MILLI } from '../../src/domain/model/sale-totals.js';
import { findTablesWithoutForcedRls } from './support/rls-catalog.js';
import {
  BUSINESS_A,
  BUSINESS_B,
  resetData,
  seedBusiness,
  seedProduct,
  type SeededBusiness,
} from './support/seed.js';

/**
 * El esquema REAL que crean las migraciones de prisma/migrations (ADR 0021): las veinte tablas del modelo
 * congelado (ADR 0020) y la revision de ventas (ADR 0027), la seguridad por fila (ADR 0005) y las reglas que la base hace cumplir. Las
 * especificaciones del Ciclo 1 (existencias, catalogo, folios, aislamiento) corren sobre estas mismas tablas.
 */

const MODEL_DOC = resolve(import.meta.dirname, '../../docs/dominio/modelo-de-datos.md');

/** Las tablas que lista el documento del modelo de datos. */
function tablesInModelDocument(): string[] {
  const text = readFileSync(MODEL_DOC, 'utf8');
  return [
    ...text.matchAll(
      /^\| *`([a-z][a-z_]*)` *\| *(?:Identidad y acceso|Catálogo|Inventario|Ventas|Caja|Reportes|Sincronización) *\|/gm,
    ),
  ]
    .map((match) => match[1] ?? '')
    .sort();
}

/** Lo que `stock_app` puede hacer en cada tabla: S = leer, I = agregar, U = cambiar, D = borrar. Nada mas. */
const PRIVILEGES: Record<string, string> = {
  business: 'SIU',
  branch: 'SIU',
  app_user: 'SIU',
  device: 'SIU',
  device_counter: 'SIU',
  category: 'SIUD',
  product: 'SIU',
  warehouse: 'SIU',
  supplier: 'SIUD',
  purchase: 'SI',
  purchase_line: 'SI',
  stock_movement: 'SI',
  stock_balance: 'S',
  operation: 'SI',
  cash_shift: 'SIU',
  cash_movement: 'SI',
  sale: 'SI',
  sale_line: 'SI',
  payment: 'SI',
  sale_void: 'SI',
  sale_review: 'SI',
};

const PRIVILEGE_NAMES = { S: 'SELECT', I: 'INSERT', U: 'UPDATE', D: 'DELETE' } as const;

async function codeOf(attempt: Promise<unknown>): Promise<string | undefined> {
  try {
    await attempt;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('real schema (ADR 0021)', () => {
  let admin: pg.Pool;

  beforeAll(() => {
    admin = createAdminPool();
  });

  afterAll(async () => {
    await admin.end();
  });

  describe('the migration', () => {
    /** El primer bloque DO de la migracion: la guardia que exige que el rol de la aplicacion ya exista. */
    const guard = (): string => {
      const directory = resolve(import.meta.dirname, '../../prisma/migrations');
      const [folder] = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
      const sql = readFileSync(resolve(directory, folder!, 'migration.sql'), 'utf8');
      return /DO \$\$[\s\S]*?END \$\$;/.exec(sql)![0];
    };

    it('lets itself run when the application role exists', async () => {
      expect(await codeOf(admin.query(guard()))).toBeUndefined();
    });

    it('refuses to run, and says why, when the application role does not exist', async () => {
      const client = await admin.connect();
      try {
        // Los roles son de todo el servidor: se le cambia el nombre solo dentro de esta transaccion.
        await client.query('BEGIN');
        await client.query(`ALTER ROLE ${APP_ROLE} RENAME TO stock_app_ausente`);
        const message = await client.query(guard()).then(
          () => '',
          (error: Error) => error.message,
        );

        expect(message).toContain('Falta el rol stock_app');
        expect(message).toContain('docs/ambientes.md');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  describe('tables', () => {
    it('are exactly the ones in the data model document', async () => {
      const result = await admin.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'
          ORDER BY table_name`,
      );

      expect(result.rows.map((row) => row.table_name)).toEqual(tablesInModelDocument());
      expect(result.rows).toHaveLength(21);
    });

    it('have forced row level security when they carry id_negocio', async () => {
      expect(await findTablesWithoutForcedRls(admin, 'public')).toEqual([]);
    });

    it('have it on business too, which is the business itself and has no id_negocio', async () => {
      const result = await admin.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class
          WHERE relnamespace = 'public'::regnamespace AND relname = 'business'`,
      );

      expect(result.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    });

    it('point only to rows of their own business: every foreign key carries id_negocio', async () => {
      const result = await admin.query<{
        table_name: string;
        constraint_name: string;
        columns: string[];
      }>(
        `SELECT c.conrelid::regclass::text AS table_name, c.conname AS constraint_name,
                array(SELECT a.attname FROM unnest(c.conkey) k
                        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k) AS columns
           FROM pg_constraint c
          WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
          ORDER BY 1, 2`,
      );
      const loose = result.rows.filter(
        (row) => !row.columns.includes('id_negocio') && row.table_name !== 'business',
      );

      expect(result.rows.length).toBeGreaterThan(30);
      expect(loose.map((row) => row.constraint_name)).toEqual([]);
    });
  });

  describe('the application role', () => {
    it('is not a superuser, does not bypass row level security and owns nothing', async () => {
      const role = await admin.query<{
        rolsuper: boolean;
        rolbypassrls: boolean;
        rolcreaterole: boolean;
      }>('SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = $1', [
        APP_ROLE,
      ]);
      const owned = await admin.query<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relowner = $1::regrole
         UNION ALL
         SELECT p.proname FROM pg_proc p
          WHERE p.pronamespace = 'public'::regnamespace AND p.proowner = $1::regrole`,
        [APP_ROLE],
      );

      expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
      expect(owned.rows).toEqual([]);
    });

    it.each(Object.entries(PRIVILEGES))('has exactly %s on %s', async (table, letters) => {
      const granted: string[] = [];
      for (const [letter, privilege] of Object.entries(PRIVILEGE_NAMES)) {
        const result = await admin.query<{ allowed: boolean }>(
          'SELECT has_table_privilege($1, $2, $3) AS allowed',
          [APP_ROLE, `public.${table}`, privilege],
        );
        if (result.rows[0]!.allowed) granted.push(letter);
      }

      expect(granted.join('')).toBe(
        Object.keys(PRIVILEGE_NAMES)
          .filter((letter) => letters.includes(letter))
          .join(''),
      );
    });

    it('cannot truncate, reference or create triggers on any table', async () => {
      const result = await admin.query<{ table_name: string; privilege: string }>(
        `SELECT t.table_name, p.privilege
           FROM information_schema.tables t
           CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(privilege)
          WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
            AND has_table_privilege($1, format('public.%I', t.table_name), p.privilege)`,
        [APP_ROLE],
      );

      expect(result.rows).toEqual([]);
    });
  });

  describe('rules the database enforces', () => {
    let a: SeededBusiness;
    let b: SeededBusiness;

    beforeEach(async () => {
      await resetData(admin);
      a = await seedBusiness(admin, BUSINESS_A);
      b = await seedBusiness(admin, BUSINESS_B);
    });

    const checkViolation = '23514';
    const foreignKeyViolation = '23503';

    it('rejects a row that points to another business (composite foreign key)', async () => {
      const categoryOfB = randomUUID();
      await admin.query('INSERT INTO category (id, id_negocio, name) VALUES ($1, $2, $3)', [
        categoryOfB,
        BUSINESS_B,
        'Bebidas',
      ]);

      const code = await codeOf(
        asApplication(admin, BUSINESS_A, (client) =>
          client.query(
            `INSERT INTO product (id_negocio, name, sku, unit, unit_price, tax_rate_bp, tax_kind, category_id)
             VALUES ($1, 'Agua', 'AGUA-1', 'unit', 1000, 0, 'exempt', $2)`,
            [BUSINESS_A, categoryOfB],
          ),
        ),
      );

      expect(code).toBe(foreignKeyViolation);
    });

    /** Cada caso trae su SQL y los parametros que usa, porque PostgreSQL exige que coincidan exactamente. */
    const invalid: [string, string, (seeded: SeededBusiness) => string[]][] = [
      [
        'a role that does not exist',
        "INSERT INTO app_user (id_negocio, auth_user_id, full_name, role) VALUES ($1, gen_random_uuid(), 'X', 'superadmin')",
        (s) => [s.businessId],
      ],
      [
        'a user that is neither bound nor invited',
        "INSERT INTO app_user (id_negocio, full_name, role) VALUES ($1, 'X', 'cashier')",
        (s) => [s.businessId],
      ],
      [
        'an invitation without an expiry',
        "INSERT INTO app_user (id_negocio, full_name, role, invitation_hash) VALUES ($1, 'X', 'cashier', 'abc')",
        (s) => [s.businessId],
      ],
      [
        'a device code with a character outside the alphabet',
        "INSERT INTO device (id_negocio, device_code) VALUES ($1, 'AI')",
        (s) => [s.businessId],
      ],
      [
        'a device code of one character',
        "INSERT INTO device (id_negocio, device_code) VALUES ($1, 'A')",
        (s) => [s.businessId],
      ],
      [
        'a device code of five characters',
        "INSERT INTO device (id_negocio, device_code) VALUES ($1, 'ABCDE')",
        (s) => [s.businessId],
      ],
      [
        'a device code in lowercase',
        "INSERT INTO device (id_negocio, device_code) VALUES ($1, 'ab')",
        (s) => [s.businessId],
      ],
      [
        'an operation of an unknown kind',
        "INSERT INTO operation (id_negocio, operation_id, kind, user_id) VALUES ($1, gen_random_uuid(), 'other', $2)",
        (s) => [s.businessId, s.ownerId],
      ],
      [
        'an operation with an unknown time source',
        "INSERT INTO operation (id_negocio, operation_id, kind, user_id, time_source) VALUES ($1, gen_random_uuid(), 'sale', $2, 'guess')",
        (s) => [s.businessId, s.ownerId],
      ],
      ['a business with a blank name', "INSERT INTO business (name) VALUES ('   ')", () => []],
      [
        'a warehouse with a blank name',
        "INSERT INTO warehouse (id_negocio, branch_id, name) VALUES ($1, $2, ' ')",
        (s) => [s.businessId, s.branchId],
      ],
      [
        'a supplier with a blank name',
        "INSERT INTO supplier (id_negocio, name) VALUES ($1, '')",
        (s) => [s.businessId],
      ],
      [
        'a category whose name has spaces around it',
        "INSERT INTO category (id_negocio, name) VALUES ($1, ' x ')",
        (s) => [s.businessId],
      ],
      [
        'a negative opening amount',
        'INSERT INTO cash_shift (id_negocio, device_id, user_id, opening_amount) VALUES ($1, $2, $3, -1)',
        (s) => [s.businessId, s.deviceId, s.ownerId],
      ],
    ];

    it.each(invalid)('rejects %s', async (_description, sql, parameters) => {
      expect(await codeOf(admin.query(sql, parameters(a)))).toBe(checkViolation);
    });

    it('rejects out-of-range amounts and quantities in the lines of a purchase and of a sale', async () => {
      const product = await seedProduct(admin, BUSINESS_A);
      const operationId = randomUUID();
      await admin.query(
        `INSERT INTO operation (id_negocio, operation_id, kind, user_id) VALUES ($1, $2, 'purchase', $3)`,
        [BUSINESS_A, operationId, a.ownerId],
      );
      const purchaseId = randomUUID();
      await admin.query(
        `INSERT INTO purchase (id, id_negocio, operation_id, warehouse_id) VALUES ($1, $2, $3, $4)`,
        [purchaseId, BUSINESS_A, operationId, a.warehouseId],
      );

      const attempts = [
        `INSERT INTO purchase_line (id_negocio, purchase_id, product_id, quantity_milli, unit_cost) VALUES ($1, $2, $3, 0, 10)`,
        `INSERT INTO purchase_line (id_negocio, purchase_id, product_id, quantity_milli, unit_cost) VALUES ($1, $2, $3, 1000, -1)`,
      ];
      for (const sql of attempts) {
        expect(await codeOf(admin.query(sql, [BUSINESS_A, purchaseId, product])), sql).toBe(
          checkViolation,
        );
      }
    });

    it('lets the identity context see the person own row, and only that one, before the business is known', async () => {
      const authA = (
        await admin.query<{ auth_user_id: string }>(
          'SELECT auth_user_id FROM app_user WHERE id = $1',
          [a.ownerId],
        )
      ).rows[0]!.auth_user_id;

      const seen = await asIdentity(
        admin,
        authA,
        async (client) =>
          (
            await client.query<{ id: string; id_negocio: string }>(
              'SELECT id, id_negocio FROM app_user',
            )
          ).rows,
      );

      expect(seen).toEqual([{ id: a.ownerId, id_negocio: BUSINESS_A }]);
      expect(b.ownerId).not.toBe(a.ownerId);
    });

    it('does not let the identity context change anything', async () => {
      const authA = (
        await admin.query<{ auth_user_id: string }>(
          'SELECT auth_user_id FROM app_user WHERE id = $1',
          [a.ownerId],
        )
      ).rows[0]!.auth_user_id;

      const updated = await asIdentity(admin, authA, async (client) => {
        const result = await client.query("UPDATE app_user SET full_name = 'Otra'");
        return result.rowCount;
      });

      expect(updated).toBe(0);
    });

    it('shows nothing when there is no identity and no business', async () => {
      const seen = await asApplication(
        admin,
        null,
        async (client) => (await client.query('SELECT 1 FROM app_user')).rowCount,
      );

      expect(seen).toBe(0);
    });

    it('shows a business only its own row in business', async () => {
      const names = await asApplication(admin, BUSINESS_A, async (client) =>
        (await client.query<{ id: string }>('SELECT id FROM business')).rows.map((row) => row.id),
      );

      expect(names).toEqual([BUSINESS_A]);
    });

    it('lets a new business be created inside a transaction that already carries its identifier', async () => {
      const fresh = randomUUID();

      await asApplication(admin, fresh, (client) =>
        client.query('INSERT INTO business (id, name) VALUES ($1, $2)', [fresh, 'Nuevo']),
      );

      const code = await codeOf(
        asApplication(admin, BUSINESS_A, (client) =>
          client.query('INSERT INTO business (id, name) VALUES ($1, $2)', [
            randomUUID(),
            'Intruso',
          ]),
        ),
      );
      expect(code).toBe('42501');
    });

    describe('rules on the rows that depend on others', () => {
      /** Las filas de las que cuelgan las demas, creadas de antemano con la conexion de administracion. */
      interface Family {
        businessId: string;
        ownerId: string;
        branchId: string;
        deviceId: string;
        warehouseId: string;
        productId: string;
        /** Una operacion nueva y sin usar en cada caso. */
        operationId: string;
        purchaseId: string;
        saleId: string;
      }
      let family: Family;

      const newOperation = async (kind: string): Promise<string> => {
        const operationId = randomUUID();
        await admin.query(
          'INSERT INTO operation (id_negocio, operation_id, kind, user_id) VALUES ($1, $2, $3, $4)',
          [BUSINESS_A, operationId, kind, a.ownerId],
        );
        return operationId;
      };

      beforeEach(async () => {
        const productId = await seedProduct(admin, BUSINESS_A);
        const purchaseId = randomUUID();
        await admin.query(
          'INSERT INTO purchase (id, id_negocio, operation_id, warehouse_id) VALUES ($1, $2, $3, $4)',
          [purchaseId, BUSINESS_A, await newOperation('purchase'), a.warehouseId],
        );
        const shiftId = randomUUID();
        await admin.query(
          'INSERT INTO cash_shift (id, id_negocio, device_id, user_id) VALUES ($1, $2, $3, $4)',
          [shiftId, BUSINESS_A, a.deviceId, a.ownerId],
        );
        const saleId = randomUUID();
        await admin.query(
          `INSERT INTO sale (id, id_negocio, operation_id, shift_id, folio, folio_reported, total, needs_adjustment)
           VALUES ($1, $2, $3, $4, 'F-1', 'F-1', 0, false)`,
          [saleId, BUSINESS_A, await newOperation('sale'), shiftId],
        );
        family = {
          businessId: BUSINESS_A,
          ownerId: a.ownerId,
          branchId: a.branchId,
          deviceId: a.deviceId,
          warehouseId: a.warehouseId,
          productId,
          operationId: await newOperation('adjustment'),
          purchaseId,
          saleId,
        };
      });

      const MOVEMENT =
        'INSERT INTO stock_movement (id_negocio, operation_id, warehouse_id, product_id, delta, reason, note)';
      const movement = (f: Family) => [f.businessId, f.operationId, f.warehouseId, f.productId];
      const SALE_LINE =
        'INSERT INTO sale_line (id_negocio, sale_id, product_id, quantity_milli, unit_price, tax_rate_bp, discount, tax_kind)';
      const CASH =
        'INSERT INTO cash_movement (id_negocio, operation_id, shift_id, direction, amount, reason)';

      /** [que se intenta, el SQL, los parametros]. Todos deben ser rechazados por una restriccion CHECK. */
      const rejected: [string, string, (f: Family) => unknown[]][] = [
        [
          'a branch with a blank name',
          "INSERT INTO branch (id_negocio, name) VALUES ($1, ' ')",
          (f) => [f.businessId],
        ],
        [
          'a supplier contact that is empty',
          "INSERT INTO supplier (id_negocio, name, contact) VALUES ($1, 'X', '')",
          (f) => [f.businessId],
        ],
        [
          'a person with an empty name',
          "INSERT INTO app_user (id_negocio, auth_user_id, full_name, role) VALUES ($1, gen_random_uuid(), '', 'cashier')",
          (f) => [f.businessId],
        ],
        [
          'an e-mail with two characters',
          "INSERT INTO app_user (id_negocio, auth_user_id, full_name, role, email) VALUES ($1, gen_random_uuid(), 'X', 'cashier', 'ab')",
          (f) => [f.businessId],
        ],
        [
          'an e-mail longer than 254 characters',
          "INSERT INTO app_user (id_negocio, auth_user_id, full_name, role, email) VALUES ($1, gen_random_uuid(), 'X', 'cashier', repeat('a', 255))",
          (f) => [f.businessId],
        ],
        [
          'a device name that is empty',
          "INSERT INTO device (id_negocio, device_code, name) VALUES ($1, 'AB', '')",
          (f) => [f.businessId],
        ],
        [
          'a device name of 81 characters',
          "INSERT INTO device (id_negocio, device_code, name) VALUES ($1, 'AB', repeat('x', 81))",
          (f) => [f.businessId],
        ],
        [
          'a device counter that starts at zero',
          'INSERT INTO device_counter (id_negocio, next_index) VALUES ($1, 0)',
          (f) => [f.businessId],
        ],
        [
          'a negative minimum stock',
          'UPDATE product SET min_stock_milli = -1 WHERE id = $1',
          (f) => [f.productId],
        ],
        [
          'a minimum stock above the maximum quantity',
          `UPDATE product SET min_stock_milli = ${MAX_QUANTITY_MILLI + 1} WHERE id = $1`,
          (f) => [f.productId],
        ],
        [
          'a purchase with an empty note',
          "INSERT INTO purchase (id_negocio, operation_id, warehouse_id, note) VALUES ($1, $2, $3, '')",
          (f) => [f.businessId, f.operationId, f.warehouseId],
        ],
        [
          'a purchase line above the maximum quantity',
          `INSERT INTO purchase_line (id_negocio, purchase_id, product_id, quantity_milli, unit_cost) VALUES ($1, $2, $3, ${MAX_QUANTITY_MILLI + 1}, 1)`,
          (f) => [f.businessId, f.purchaseId, f.productId],
        ],
        [
          'a purchase line with a cost above the maximum price',
          `INSERT INTO purchase_line (id_negocio, purchase_id, product_id, quantity_milli, unit_cost) VALUES ($1, $2, $3, 1, ${MAX_PESOS + 1})`,
          (f) => [f.businessId, f.purchaseId, f.productId],
        ],
        [
          'a movement of zero',
          `${MOVEMENT} VALUES ($1, $2, $3, $4, 0, 'adjustment', NULL)`,
          movement,
        ],
        [
          'a movement above the maximum quantity',
          `${MOVEMENT} VALUES ($1, $2, $3, $4, ${MAX_QUANTITY_MILLI + 1}, 'adjustment', NULL)`,
          movement,
        ],
        [
          'a movement below minus the maximum quantity',
          `${MOVEMENT} VALUES ($1, $2, $3, $4, ${-MAX_QUANTITY_MILLI - 1}, 'adjustment', NULL)`,
          movement,
        ],
        [
          'a movement with a reason that does not exist',
          `${MOVEMENT} VALUES ($1, $2, $3, $4, 1, 'theft', NULL)`,
          movement,
        ],
        [
          'a movement with an empty note',
          `${MOVEMENT} VALUES ($1, $2, $3, $4, 1, 'adjustment', '')`,
          movement,
        ],
        [
          'a negative counted amount in a shift',
          'INSERT INTO cash_shift (id_negocio, device_id, user_id, counted_amount) VALUES ($1, $2, $3, -1)',
          (f) => [f.businessId, f.deviceId, f.ownerId],
        ],
        [
          'a cash movement of zero pesos',
          `${CASH} VALUES ($1, $2, (SELECT shift_id FROM sale WHERE id = $3), 'in', 0, NULL)`,
          (f) => [f.businessId, f.operationId, f.saleId],
        ],
        [
          'a cash movement above the maximum',
          `${CASH} VALUES ($1, $2, (SELECT shift_id FROM sale WHERE id = $3), 'in', ${MAX_PESOS + 1}, NULL)`,
          (f) => [f.businessId, f.operationId, f.saleId],
        ],
        [
          'a cash movement that goes sideways',
          `${CASH} VALUES ($1, $2, (SELECT shift_id FROM sale WHERE id = $3), 'sideways', 1, NULL)`,
          (f) => [f.businessId, f.operationId, f.saleId],
        ],
        [
          'a cash movement with an empty reason',
          `${CASH} VALUES ($1, $2, (SELECT shift_id FROM sale WHERE id = $3), 'out', 1, '')`,
          (f) => [f.businessId, f.operationId, f.saleId],
        ],
        [
          'a sale with a negative total',
          "INSERT INTO sale (id_negocio, operation_id, shift_id, folio, folio_reported, total, needs_adjustment) VALUES ($1, $2, (SELECT shift_id FROM sale WHERE id = $3), 'F-2', 'F-2', -1, false)",
          (f) => [f.businessId, f.operationId, f.saleId],
        ],
        [
          'a sale above the maximum total',
          `INSERT INTO sale (id_negocio, operation_id, shift_id, folio, folio_reported, total, needs_adjustment) VALUES ($1, $2, (SELECT shift_id FROM sale WHERE id = $3), 'F-2', 'F-2', ${MAX_PESOS + 1}, false)`,
          (f) => [f.businessId, f.operationId, f.saleId],
        ],
        [
          'a sale line of zero',
          `${SALE_LINE} VALUES ($1, $2, $3, 0, 1, 0, 0, 'exempt')`,
          (f) => [f.businessId, f.saleId, f.productId],
        ],
        [
          'a sale line above the maximum quantity',
          `${SALE_LINE} VALUES ($1, $2, $3, ${MAX_QUANTITY_MILLI + 1}, 1, 0, 0, 'exempt')`,
          (f) => [f.businessId, f.saleId, f.productId],
        ],
        [
          'a sale line with a negative price',
          `${SALE_LINE} VALUES ($1, $2, $3, 1, -1, 0, 0, 'exempt')`,
          (f) => [f.businessId, f.saleId, f.productId],
        ],
        [
          'a sale line with a negative discount',
          `${SALE_LINE} VALUES ($1, $2, $3, 1, 1, 0, -1, 'exempt')`,
          (f) => [f.businessId, f.saleId, f.productId],
        ],
        [
          'a sale line with a tax rate outside the catalogue',
          `${SALE_LINE} VALUES ($1, $2, $3, 1, 1, 800, 0, 'taxed')`,
          (f) => [f.businessId, f.saleId, f.productId],
        ],
        [
          'a sale line sold as taxed at 0 %',
          `${SALE_LINE} VALUES ($1, $2, $3, 1, 1, 0, 0, 'taxed')`,
          (f) => [f.businessId, f.saleId, f.productId],
        ],
        [
          'a sale line sold as exempt at 19 %',
          `${SALE_LINE} VALUES ($1, $2, $3, 1, 1, 1900, 0, 'exempt')`,
          (f) => [f.businessId, f.saleId, f.productId],
        ],
        [
          'a sale line sold as excluded at 5 %',
          `${SALE_LINE} VALUES ($1, $2, $3, 1, 1, 500, 0, 'excluded')`,
          (f) => [f.businessId, f.saleId, f.productId],
        ],
        [
          'a sale line with a tax kind that does not exist',
          `${SALE_LINE} VALUES ($1, $2, $3, 1, 1, 0, 0, 'gravado')`,
          (f) => [f.businessId, f.saleId, f.productId],
        ],
        [
          'a payment by a method that does not exist',
          "INSERT INTO payment (id_negocio, sale_id, method, amount) VALUES ($1, $2, 'crypto', 1)",
          (f) => [f.businessId, f.saleId],
        ],
        [
          'a payment of zero pesos',
          "INSERT INTO payment (id_negocio, sale_id, method, amount) VALUES ($1, $2, 'cash', 0)",
          (f) => [f.businessId, f.saleId],
        ],
        [
          'a payment above the maximum',
          `INSERT INTO payment (id_negocio, sale_id, method, amount) VALUES ($1, $2, 'cash', ${MAX_PESOS + 1})`,
          (f) => [f.businessId, f.saleId],
        ],
        [
          'a payment with an empty reference',
          "INSERT INTO payment (id_negocio, sale_id, method, amount, reference) VALUES ($1, $2, 'card', 1, '')",
          (f) => [f.businessId, f.saleId],
        ],
        [
          'a void with a blank reason',
          "INSERT INTO sale_void (id_negocio, sale_id, operation_id, reason) VALUES ($1, $2, $3, ' ')",
          (f) => [f.businessId, f.saleId, f.operationId],
        ],
      ];

      it.each(rejected)('rejects %s', async (_description, sql, parameters) => {
        const attempt = asApplication(admin, BUSINESS_A, (client) =>
          client.query(sql, parameters(family)),
        );
        expect(await codeOf(attempt)).toBe(checkViolation);
      });

      /** Los valores de la orilla: lo mas grande y lo mas chico que el dominio acepta tiene que entrar. */
      const accepted: [string, string, (f: Family) => unknown[]][] = [
        [
          'the largest quantity in a purchase line',
          `INSERT INTO purchase_line (id_negocio, purchase_id, product_id, quantity_milli, unit_cost) VALUES ($1, $2, $3, ${MAX_QUANTITY_MILLI}, ${MAX_PESOS})`,
          (f) => [f.businessId, f.purchaseId, f.productId],
        ],
        [
          'the smallest quantity in a purchase line',
          'INSERT INTO purchase_line (id_negocio, purchase_id, product_id, quantity_milli, unit_cost) VALUES ($1, $2, $3, 1, 0)',
          (f) => [f.businessId, f.purchaseId, f.productId],
        ],
        [
          'a movement of plus and of minus the maximum quantity',
          `${MOVEMENT} VALUES ($1, $2, $3, $4, ${MAX_QUANTITY_MILLI}, 'purchase', 'x'), ($1, $2, $3, $4, ${-MAX_QUANTITY_MILLI}, 'void', NULL)`,
          movement,
        ],
        [
          'a cash movement of one peso and of the maximum',
          `${CASH} VALUES ($1, $2, (SELECT shift_id FROM sale WHERE id = $3), 'in', 1, NULL), ($1, $2, (SELECT shift_id FROM sale WHERE id = $3), 'out', ${MAX_PESOS}, 'x')`,
          (f) => [f.businessId, f.operationId, f.saleId],
        ],
        [
          'a sale with a total of zero',
          `INSERT INTO sale (id_negocio, operation_id, shift_id, folio, folio_reported, total, needs_adjustment) VALUES ($1, $2, (SELECT shift_id FROM sale WHERE id = $3), 'F-2', 'F-2', 0, false)`,
          (f) => [f.businessId, f.operationId, f.saleId],
        ],
        [
          'a sale line at the limits',
          `${SALE_LINE} VALUES ($1, $2, $3, ${MAX_QUANTITY_MILLI}, ${MAX_PESOS}, 1900, ${MAX_PESOS}, 'taxed'), ($1, $2, $3, 1, 0, 0, 0, 'exempt')`,
          (f) => [f.businessId, f.saleId, f.productId],
        ],
        [
          'each payment method',
          `INSERT INTO payment (id_negocio, sale_id, method, amount) VALUES ($1, $2, 'cash', 1), ($1, $2, 'card', 1), ($1, $2, 'transfer', ${MAX_PESOS})`,
          (f) => [f.businessId, f.saleId],
        ],
        [
          'a minimum stock equal to the maximum quantity',
          `UPDATE product SET min_stock_milli = ${MAX_QUANTITY_MILLI} WHERE id = $1`,
          (f) => [f.productId],
        ],
        [
          'an e-mail of three characters and one of 254',
          "INSERT INTO app_user (id_negocio, auth_user_id, full_name, role, email) VALUES ($1, gen_random_uuid(), 'X', 'cashier', 'a@b'), ($1, gen_random_uuid(), 'Y', 'cashier', repeat('a', 254))",
          (f) => [f.businessId],
        ],
        [
          'a device name of 80 characters and a four-character code',
          "INSERT INTO device (id_negocio, device_code, name) VALUES ($1, 'ABCD', repeat('x', 80))",
          (f) => [f.businessId],
        ],
        [
          'a counter at one',
          'INSERT INTO device_counter (id_negocio, next_index) VALUES ($1, 1)',
          (f) => [f.businessId],
        ],
      ];

      it.each(accepted)('accepts %s', async (_description, sql, parameters) => {
        const attempt = asApplication(admin, BUSINESS_A, (client) =>
          client.query(sql, parameters(family)),
        );
        expect(await codeOf(attempt)).toBeUndefined();
      });

      it.each(ROLES)('accepts the role %s, which the domain knows', async (role) => {
        const code = await codeOf(
          admin.query(
            'INSERT INTO app_user (id_negocio, auth_user_id, full_name, role) VALUES ($1, gen_random_uuid(), $2, $3)',
            [BUSINESS_A, `Persona ${role}`, role],
          ),
        );

        expect(code).toBeUndefined();
      });
    });

    it('makes the tables with history append-only, even for whoever owns them', async () => {
      const result = await admin.query<{ table_name: string; event: string }>(
        `SELECT c.relname AS table_name,
                CASE WHEN t.tgtype & 32 <> 0 THEN 'truncate' ELSE 'change' END AS event
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND t.tgenabled = 'O'
            AND t.tgfoid = 'public.refuse_history_change'::regproc
          ORDER BY 1, 2`,
      );
      const history = [
        'cash_movement',
        'operation',
        'payment',
        'purchase',
        'purchase_line',
        'sale',
        'sale_line',
        'sale_review',
        'sale_void',
        'stock_movement',
      ];

      expect(result.rows).toEqual(
        history.flatMap((table_name) => [
          { table_name, event: 'change' },
          { table_name, event: 'truncate' },
        ]),
      );
    });

    it('does not let the unit of a product change once it has stock movements (debt of ADR 0015)', async () => {
      const withMovements = await seedProduct(admin, BUSINESS_A);
      const without = await seedProduct(admin, BUSINESS_A);
      const operationId = randomUUID();
      await admin.query(
        `INSERT INTO operation (id_negocio, operation_id, kind, user_id) VALUES ($1, $2, 'adjustment', $3)`,
        [BUSINESS_A, operationId, a.ownerId],
      );

      await asApplication(admin, BUSINESS_A, async (client) => {
        await client.query(
          `INSERT INTO stock_movement (id_negocio, operation_id, warehouse_id, product_id, delta, reason)
           VALUES ($1, $2, $3, $4, 1000, 'adjustment')`,
          [BUSINESS_A, operationId, a.warehouseId, withMovements],
        );
      });

      const changed = await codeOf(
        asApplication(admin, BUSINESS_A, (client) =>
          client.query("UPDATE product SET unit = 'kilogram' WHERE id = $1", [withMovements]),
        ),
      );
      const free = await codeOf(
        asApplication(admin, BUSINESS_A, (client) =>
          client.query("UPDATE product SET unit = 'kilogram' WHERE id = $1", [without]),
        ),
      );
      const otherFields = await codeOf(
        asApplication(admin, BUSINESS_A, (client) =>
          client.query('UPDATE product SET unit_price = 2000 WHERE id = $1', [withMovements]),
        ),
      );

      expect(changed).toBe('23514');
      expect(free).toBeUndefined();
      expect(otherFields).toBeUndefined();
    });
  });
});
