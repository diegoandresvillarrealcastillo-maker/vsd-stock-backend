import type pg from 'pg';
import { MAX_PESOS } from '../../../src/domain/model/money.js';
import { TAX_RATES_BP } from '../../../src/domain/model/tax.js';
import { UNITS_OF_MEASURE } from '../../../src/domain/model/unit-of-measure.js';
import { APP_ROLE } from './database.js';

/**
 * Especificacion ejecutable de lo que el ADR 0015 pide a la base de datos del catalogo. Es un esquema
 * de juguete (como el de ledger-design.ts): las migraciones reales del Ciclo 2 lo traducen a Prisma.
 *
 * Las unidades, las tarifas y el precio maximo salen de las constantes del DOMINIO, no se copian a
 * mano: si el dominio agrega una unidad, el esquema la acepta; la migracion real debe hacer lo mismo
 * o una prueba como esta lo dira.
 */

export const CATALOG_SCHEMA = 'catalog_design';

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(', ');

export async function createCatalogDesign(admin: pg.Pool): Promise<void> {
  await dropCatalogDesign(admin);
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE ${APP_ROLE} NOLOGIN NOSUPERUSER NOBYPASSRLS;
      END IF;
    END $$;
    CREATE SCHEMA ${CATALOG_SCHEMA};
    GRANT USAGE ON SCHEMA ${CATALOG_SCHEMA} TO ${APP_ROLE};

    CREATE TABLE ${CATALOG_SCHEMA}.product (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      id_negocio uuid NOT NULL,
      name text NOT NULL
        CONSTRAINT product_name_shape CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 120),
      sku text NOT NULL
        CONSTRAINT product_sku_shape CHECK (
          char_length(sku) BETWEEN 1 AND 40 AND sku ~ '^[A-Za-z0-9._/-]+( [A-Za-z0-9._/-]+)*$'
        ),
      -- La clave que se compara es la que calcula la base, no la aplicacion: no se puede olvidar.
      sku_key text GENERATED ALWAYS AS (upper(sku)) STORED,
      barcode text
        CONSTRAINT product_barcode_shape CHECK (
          barcode IS NULL OR (
            barcode ~ '^[0-9]+$' AND char_length(barcode) IN (8, 12, 13, 14) AND barcode !~ '^0+$'
          )
        ),
      barcode_key text GENERATED ALWAYS AS (lpad(barcode, 14, '0')) STORED,
      unit text NOT NULL CONSTRAINT product_unit_known CHECK (unit IN (${quoted(Object.keys(UNITS_OF_MEASURE))})),
      unit_price bigint NOT NULL
        CONSTRAINT product_price_range CHECK (unit_price BETWEEN 0 AND ${MAX_PESOS}),
      tax_rate_bp integer NOT NULL
        CONSTRAINT product_tax_rate_known CHECK (tax_rate_bp IN (${TAX_RATES_BP.join(', ')})),
      active boolean NOT NULL DEFAULT true,
      -- Unicos por negocio, archivados incluidos. Los NULL no chocan entre si: se puede no tener codigo de barras.
      CONSTRAINT product_sku_unique UNIQUE (id_negocio, sku_key),
      CONSTRAINT product_barcode_unique UNIQUE (id_negocio, barcode_key)
    );

    GRANT SELECT, INSERT, UPDATE ON ${CATALOG_SCHEMA}.product TO ${APP_ROLE};

    ALTER TABLE ${CATALOG_SCHEMA}.product ENABLE ROW LEVEL SECURITY;
    ALTER TABLE ${CATALOG_SCHEMA}.product FORCE ROW LEVEL SECURITY;
    CREATE POLICY business_isolation ON ${CATALOG_SCHEMA}.product
      USING (id_negocio = nullif(current_setting('app.id_negocio', true), '')::uuid)
      WITH CHECK (id_negocio = nullif(current_setting('app.id_negocio', true), '')::uuid);
  `);
}

export async function dropCatalogDesign(admin: pg.Pool): Promise<void> {
  await admin.query(`DROP SCHEMA IF EXISTS ${CATALOG_SCHEMA} CASCADE`);
}
