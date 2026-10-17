-- Modelo inicial (ADR 0021): las veinte tablas del modelo congelado (ADR 0020, docs/dominio/modelo-de-datos.md).
--
-- La estructura (tablas, claves, indices) la genera Prisma a partir de prisma/schema.prisma. Lo que Prisma no
-- expresa se escribio a mano en este mismo archivo: columnas generadas, restricciones CHECK, seguridad por fila,
-- disparadores y permisos. Una prueba compara el schema con la base que sale de aqui (npm run db:check-schema).
--
-- La aplica UNA PERSONA con el rol dueno de las tablas (ADR 0010), nunca el CI sobre un ambiente, y despues de
-- comprobar a que base apunta la conexion (npm run db:migrate). Una migracion aplicada no se edita: el cambio
-- va en una nueva.

-- El rol de la aplicacion (ADR 0005) lo crea la persona antes de migrar: lleva contrasena y esa no se versiona.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'stock_app') THEN
    RAISE EXCEPTION 'Falta el rol stock_app: crealo antes de migrar (docs/ambientes.md, "Preparar PRE")';
  END IF;
END $$;

-- CreateTable
CREATE TABLE "business" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "business_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "auth_user_id" UUID,
    "email" TEXT,
    "full_name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "invitation_hash" TEXT,
    "invitation_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivated_at" TIMESTAMPTZ(6),

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "device_code" TEXT NOT NULL,
    "name" TEXT,
    "enrolled_by_user_id" UUID,
    "enrolled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_counter" (
    "id_negocio" UUID NOT NULL,
    "next_index" INTEGER NOT NULL,

    CONSTRAINT "device_counter_pkey" PRIMARY KEY ("id_negocio")
);

-- CreateTable
CREATE TABLE "category" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "name_key" TEXT GENERATED ALWAYS AS (lower("name")) STORED,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "sku_key" TEXT GENERATED ALWAYS AS (upper("sku")) STORED,
    "barcode" TEXT,
    "barcode_key" TEXT GENERATED ALWAYS AS (lpad("barcode", 14, '0')) STORED,
    "unit" TEXT NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "tax_rate_bp" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "category_id" UUID,
    "min_stock_milli" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "contact" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "supplier_id" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,

    CONSTRAINT "purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity_milli" BIGINT NOT NULL,
    "unit_cost" BIGINT NOT NULL,

    CONSTRAINT "purchase_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "delta" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balance" (
    "id_negocio" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" BIGINT NOT NULL,

    CONSTRAINT "stock_balance_pkey" PRIMARY KEY ("id_negocio","warehouse_id","product_id")
);

-- CreateTable
CREATE TABLE "operation" (
    "id_negocio" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "device_time_raw" TEXT,
    "time_source" TEXT NOT NULL DEFAULT 'received',
    "time_flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "body_hash" TEXT,

    CONSTRAINT "operation_pkey" PRIMARY KEY ("id_negocio","operation_id")
);

-- CreateTable
CREATE TABLE "cash_shift" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "opening_amount" BIGINT NOT NULL DEFAULT 0,
    "counted_amount" BIGINT,

    CONSTRAINT "cash_shift_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_movement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "cash_movement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "shift_id" UUID NOT NULL,
    "folio" TEXT NOT NULL,
    "folio_reported" TEXT NOT NULL,
    "folio_conflict" BOOLEAN NOT NULL DEFAULT false,
    "total" BIGINT NOT NULL,
    "needs_adjustment" BOOLEAN NOT NULL,

    CONSTRAINT "sale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_line" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity_milli" BIGINT NOT NULL,
    "unit_price" BIGINT NOT NULL,
    "tax_rate_bp" INTEGER NOT NULL,
    "discount" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "sale_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "reference" TEXT,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_void" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sale_void_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "branch_id_negocio_id_key" ON "branch"("id_negocio", "id");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_auth_user_id_key" ON "app_user"("auth_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_id_negocio_id_key" ON "app_user"("id_negocio", "id");

-- CreateIndex
CREATE UNIQUE INDEX "device_code_unique" ON "device"("id_negocio", "device_code");

-- CreateIndex
CREATE UNIQUE INDEX "device_id_negocio_id_key" ON "device"("id_negocio", "id");

-- CreateIndex
CREATE UNIQUE INDEX "category_name_unique" ON "category"("id_negocio", "name_key");

-- CreateIndex
CREATE UNIQUE INDEX "category_id_negocio_id_key" ON "category"("id_negocio", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_sku_unique" ON "product"("id_negocio", "sku_key");

-- CreateIndex
CREATE UNIQUE INDEX "product_barcode_unique" ON "product"("id_negocio", "barcode_key");

-- CreateIndex
CREATE UNIQUE INDEX "product_id_negocio_id_key" ON "product"("id_negocio", "id");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_id_negocio_id_key" ON "warehouse"("id_negocio", "id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_id_negocio_id_key" ON "supplier"("id_negocio", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_operation_unique" ON "purchase"("id_negocio", "operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_id_negocio_id_key" ON "purchase"("id_negocio", "id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_line_product_unique" ON "purchase_line"("id_negocio", "purchase_id", "product_id");

-- CreateIndex
CREATE INDEX "stock_movement_product" ON "stock_movement"("id_negocio", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "cash_shift_id_negocio_id_key" ON "cash_shift"("id_negocio", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_operation_unique" ON "sale"("id_negocio", "operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_folio_unique" ON "sale"("id_negocio", "folio");

-- CreateIndex
CREATE UNIQUE INDEX "sale_id_negocio_id_key" ON "sale"("id_negocio", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_void_sale_unique" ON "sale_void"("id_negocio", "sale_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_void_operation_unique" ON "sale_void"("id_negocio", "operation_id");

-- AddForeignKey
ALTER TABLE "branch" ADD CONSTRAINT "branch_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_id_negocio_enrolled_by_user_id_fkey" FOREIGN KEY ("id_negocio", "enrolled_by_user_id") REFERENCES "app_user"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_counter" ADD CONSTRAINT "device_counter_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "category" ADD CONSTRAINT "category_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_id_negocio_category_id_fkey" FOREIGN KEY ("id_negocio", "category_id") REFERENCES "category"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_id_negocio_branch_id_fkey" FOREIGN KEY ("id_negocio", "branch_id") REFERENCES "branch"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_id_negocio_operation_id_fkey" FOREIGN KEY ("id_negocio", "operation_id") REFERENCES "operation"("id_negocio", "operation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_id_negocio_warehouse_id_fkey" FOREIGN KEY ("id_negocio", "warehouse_id") REFERENCES "warehouse"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_id_negocio_supplier_id_fkey" FOREIGN KEY ("id_negocio", "supplier_id") REFERENCES "supplier"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_id_negocio_created_by_user_id_fkey" FOREIGN KEY ("id_negocio", "created_by_user_id") REFERENCES "app_user"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_id_negocio_purchase_id_fkey" FOREIGN KEY ("id_negocio", "purchase_id") REFERENCES "purchase"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_id_negocio_product_id_fkey" FOREIGN KEY ("id_negocio", "product_id") REFERENCES "product"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_id_negocio_operation_id_fkey" FOREIGN KEY ("id_negocio", "operation_id") REFERENCES "operation"("id_negocio", "operation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_id_negocio_warehouse_id_fkey" FOREIGN KEY ("id_negocio", "warehouse_id") REFERENCES "warehouse"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_id_negocio_product_id_fkey" FOREIGN KEY ("id_negocio", "product_id") REFERENCES "product"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_id_negocio_warehouse_id_fkey" FOREIGN KEY ("id_negocio", "warehouse_id") REFERENCES "warehouse"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balance" ADD CONSTRAINT "stock_balance_id_negocio_product_id_fkey" FOREIGN KEY ("id_negocio", "product_id") REFERENCES "product"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation" ADD CONSTRAINT "operation_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation" ADD CONSTRAINT "operation_id_negocio_user_id_fkey" FOREIGN KEY ("id_negocio", "user_id") REFERENCES "app_user"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operation" ADD CONSTRAINT "operation_id_negocio_device_id_fkey" FOREIGN KEY ("id_negocio", "device_id") REFERENCES "device"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_id_negocio_device_id_fkey" FOREIGN KEY ("id_negocio", "device_id") REFERENCES "device"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_id_negocio_user_id_fkey" FOREIGN KEY ("id_negocio", "user_id") REFERENCES "app_user"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_id_negocio_operation_id_fkey" FOREIGN KEY ("id_negocio", "operation_id") REFERENCES "operation"("id_negocio", "operation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_id_negocio_shift_id_fkey" FOREIGN KEY ("id_negocio", "shift_id") REFERENCES "cash_shift"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_id_negocio_operation_id_fkey" FOREIGN KEY ("id_negocio", "operation_id") REFERENCES "operation"("id_negocio", "operation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale" ADD CONSTRAINT "sale_id_negocio_shift_id_fkey" FOREIGN KEY ("id_negocio", "shift_id") REFERENCES "cash_shift"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_line" ADD CONSTRAINT "sale_line_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_line" ADD CONSTRAINT "sale_line_id_negocio_sale_id_fkey" FOREIGN KEY ("id_negocio", "sale_id") REFERENCES "sale"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_line" ADD CONSTRAINT "sale_line_id_negocio_product_id_fkey" FOREIGN KEY ("id_negocio", "product_id") REFERENCES "product"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_id_negocio_sale_id_fkey" FOREIGN KEY ("id_negocio", "sale_id") REFERENCES "sale"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_void" ADD CONSTRAINT "sale_void_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_void" ADD CONSTRAINT "sale_void_id_negocio_sale_id_fkey" FOREIGN KEY ("id_negocio", "sale_id") REFERENCES "sale"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_void" ADD CONSTRAINT "sale_void_id_negocio_operation_id_fkey" FOREIGN KEY ("id_negocio", "operation_id") REFERENCES "operation"("id_negocio", "operation_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================================================
-- Reglas que la base hace cumplir (CHECK). Las constantes salen del dominio (src/domain/model): unidades,
-- tarifas, roles, alfabeto de los codigos de dispositivo, precio y cantidad maximos. Las pruebas de
-- test/integration las recorren una por una, asi que si el dominio cambia y esto no, una prueba lo dice.
-- ===========================================================================================================

-- Un nombre: sin espacios sobrantes, de 1 a 120 caracteres y sin caracteres de control.
ALTER TABLE "business" ADD CONSTRAINT "business_name_shape"
  CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 120 AND "name" !~ '[[:cntrl:]]');
ALTER TABLE "branch" ADD CONSTRAINT "branch_name_shape"
  CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 120 AND "name" !~ '[[:cntrl:]]');
ALTER TABLE "warehouse" ADD CONSTRAINT "warehouse_name_shape"
  CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 120 AND "name" !~ '[[:cntrl:]]');
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_name_shape"
  CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 120 AND "name" !~ '[[:cntrl:]]');
ALTER TABLE "supplier" ADD CONSTRAINT "supplier_contact_shape"
  CHECK ("contact" IS NULL OR (char_length("contact") BETWEEN 1 AND 200 AND "contact" !~ '[[:cntrl:]]'));
ALTER TABLE "category" ADD CONSTRAINT "category_name_shape"
  CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 120 AND "name" !~ '[[:cntrl:]]');

-- Personas (ADR 0017): tres roles; una fila o esta ligada a una identidad o es una invitacion pendiente.
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_full_name_shape"
  CHECK ("full_name" = btrim("full_name") AND char_length("full_name") BETWEEN 1 AND 120 AND "full_name" !~ '[[:cntrl:]]');
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_email_shape"
  CHECK ("email" IS NULL OR ("email" = btrim("email") AND char_length("email") BETWEEN 3 AND 254));
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_role_known"
  CHECK ("role" IN ('owner', 'admin', 'cashier'));
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_bound_or_invited"
  CHECK (
    "auth_user_id" IS NOT NULL
    OR ("invitation_hash" IS NOT NULL AND "invitation_expires_at" IS NOT NULL)
  );

-- Dispositivos (ADR 0016): de 2 a 4 caracteres del alfabeto sin 0, 1, I, L, O ni U.
ALTER TABLE "device" ADD CONSTRAINT "device_code_shape"
  CHECK ("device_code" ~ '^[ABCDEFGHJKMNPQRSTVWXYZ2-9]{2,4}$');
ALTER TABLE "device" ADD CONSTRAINT "device_name_shape"
  CHECK ("name" IS NULL OR (char_length("name") BETWEEN 1 AND 80 AND "name" !~ '[[:cntrl:]]'));
ALTER TABLE "device_counter" ADD CONSTRAINT "device_counter_positive" CHECK ("next_index" >= 1);

-- Catalogo (ADR 0014 y 0015): el mismo contrato que el dominio, hecho cumplir por la base.
ALTER TABLE "product" ADD CONSTRAINT "product_name_shape"
  CHECK ("name" = btrim("name") AND char_length("name") BETWEEN 1 AND 120 AND "name" !~ '[[:cntrl:]]');
ALTER TABLE "product" ADD CONSTRAINT "product_sku_shape"
  CHECK (char_length("sku") BETWEEN 1 AND 40 AND "sku" ~ '^[A-Za-z0-9._/-]+( [A-Za-z0-9._/-]+)*$');
ALTER TABLE "product" ADD CONSTRAINT "product_barcode_shape"
  CHECK (
    "barcode" IS NULL
    OR ("barcode" ~ '^[0-9]+$' AND char_length("barcode") IN (8, 12, 13, 14) AND "barcode" !~ '^0+$')
  );
ALTER TABLE "product" ADD CONSTRAINT "product_unit_known"
  CHECK ("unit" IN ('unit', 'kilogram', 'gram', 'pound', 'liter', 'milliliter'));
ALTER TABLE "product" ADD CONSTRAINT "product_price_range"
  CHECK ("unit_price" BETWEEN 0 AND 1000000000000);
ALTER TABLE "product" ADD CONSTRAINT "product_tax_rate_known"
  CHECK ("tax_rate_bp" IN (0, 500, 1900));
ALTER TABLE "product" ADD CONSTRAINT "product_min_stock_range"
  CHECK ("min_stock_milli" IS NULL OR "min_stock_milli" BETWEEN 0 AND 1000000000);

-- Inventario: cantidades en milesimas (de 1 a un millon de unidades) y costos en pesos enteros.
ALTER TABLE "purchase" ADD CONSTRAINT "purchase_note_shape"
  CHECK ("note" IS NULL OR (char_length("note") BETWEEN 1 AND 500 AND "note" !~ '[[:cntrl:]]'));
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_quantity_range"
  CHECK ("quantity_milli" BETWEEN 1 AND 1000000000);
ALTER TABLE "purchase_line" ADD CONSTRAINT "purchase_line_cost_range"
  CHECK ("unit_cost" BETWEEN 0 AND 1000000000000);
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_delta_range"
  CHECK ("delta" <> 0 AND "delta" BETWEEN -1000000000 AND 1000000000);
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_reason_known"
  CHECK ("reason" IN ('sale', 'purchase', 'adjustment', 'void'));
ALTER TABLE "stock_movement" ADD CONSTRAINT "stock_movement_note_shape"
  CHECK ("note" IS NULL OR (char_length("note") BETWEEN 1 AND 500 AND "note" !~ '[[:cntrl:]]'));

-- Sincronizacion (ADR 0009, 0016 y 0019).
ALTER TABLE "operation" ADD CONSTRAINT "operation_kind_known"
  CHECK ("kind" IN ('sale', 'sale_void', 'purchase', 'adjustment', 'shift_open', 'shift_close', 'cash_movement'));
ALTER TABLE "operation" ADD CONSTRAINT "operation_time_source_known"
  CHECK ("time_source" IN ('device', 'corrected', 'received'));

-- Caja.
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_amounts_range"
  CHECK (
    "opening_amount" BETWEEN 0 AND 1000000000000
    AND ("counted_amount" IS NULL OR "counted_amount" BETWEEN 0 AND 1000000000000)
  );
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_direction_known"
  CHECK ("direction" IN ('in', 'out'));
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_amount_range"
  CHECK ("amount" BETWEEN 1 AND 1000000000000);
ALTER TABLE "cash_movement" ADD CONSTRAINT "cash_movement_reason_shape"
  CHECK ("reason" IS NULL OR (char_length("reason") BETWEEN 1 AND 200 AND "reason" !~ '[[:cntrl:]]'));

-- Ventas.
ALTER TABLE "sale" ADD CONSTRAINT "sale_total_range" CHECK ("total" BETWEEN 0 AND 1000000000000);
ALTER TABLE "sale_line" ADD CONSTRAINT "sale_line_quantity_range"
  CHECK ("quantity_milli" BETWEEN 1 AND 1000000000);
ALTER TABLE "sale_line" ADD CONSTRAINT "sale_line_amounts_range"
  CHECK ("unit_price" BETWEEN 0 AND 1000000000000 AND "discount" BETWEEN 0 AND 1000000000000);
ALTER TABLE "sale_line" ADD CONSTRAINT "sale_line_tax_rate_known" CHECK ("tax_rate_bp" IN (0, 500, 1900));
ALTER TABLE "payment" ADD CONSTRAINT "payment_method_known" CHECK ("method" IN ('cash', 'card', 'transfer'));
ALTER TABLE "payment" ADD CONSTRAINT "payment_amount_range" CHECK ("amount" BETWEEN 1 AND 1000000000000);
ALTER TABLE "payment" ADD CONSTRAINT "payment_reference_shape"
  CHECK ("reference" IS NULL OR (char_length("reference") BETWEEN 1 AND 100 AND "reference" !~ '[[:cntrl:]]'));
ALTER TABLE "sale_void" ADD CONSTRAINT "sale_void_reason_shape"
  CHECK ("reason" = btrim("reason") AND char_length("reason") BETWEEN 1 AND 200 AND "reason" !~ '[[:cntrl:]]');

-- ===========================================================================================================
-- Seguridad por fila (ADR 0005): habilitada Y forzada en toda tabla, con una politica que compara el negocio de
-- la fila con el de la transaccion. Sin contexto, la comparacion da nulo y la consulta ve cero filas.
-- ===========================================================================================================

ALTER TABLE "business" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "business" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_isolation ON "business"
  USING ("id" = nullif(current_setting('app.id_negocio', true), '')::uuid)
  WITH CHECK ("id" = nullif(current_setting('app.id_negocio', true), '')::uuid);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'branch', 'app_user', 'device', 'device_counter', 'category', 'product', 'warehouse', 'supplier',
    'purchase', 'purchase_line', 'stock_movement', 'stock_balance', 'operation', 'cash_shift',
    'cash_movement', 'sale', 'sale_line', 'payment', 'sale_void'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY business_isolation ON %I
         USING ("id_negocio" = nullif(current_setting(''app.id_negocio'', true), '''')::uuid)
         WITH CHECK ("id_negocio" = nullif(current_setting(''app.id_negocio'', true), '''')::uuid)',
      t
    );
  END LOOP;
END $$;

-- Identidad (ADR 0022): la API conoce quien es la persona (el `sub` del token verificado) antes de saber su
-- negocio. Esta segunda politica, solo de lectura, le deja ver SU fila y ninguna otra; con ella resuelve el negocio
-- y recien entonces abre la transaccion con `app.id_negocio`.
CREATE POLICY identity_lookup ON "app_user" FOR SELECT
  USING ("auth_user_id" = nullif(current_setting('app.auth_user_id', true), '')::uuid);

-- ===========================================================================================================
-- Disparadores
-- ===========================================================================================================

-- La existencia se deriva del libro (ADR 0013): cada movimiento suma su cambio al saldo en la MISMA transaccion.
-- El upsert toma el candado de la fila del saldo, asi que dos ventas del mismo producto se turnan en lugar de
-- pisarse. SECURITY DEFINER: la aplicacion no puede escribir el saldo, pero el disparador si, y solo con lo que el
-- movimiento (que ya paso por RLS) dicta.
CREATE FUNCTION public.apply_stock_movement() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.stock_balance AS b (id_negocio, warehouse_id, product_id, quantity)
  VALUES (NEW.id_negocio, NEW.warehouse_id, NEW.product_id, NEW.delta)
  ON CONFLICT (id_negocio, warehouse_id, product_id)
  DO UPDATE SET quantity = b.quantity + EXCLUDED.quantity;
  RETURN NULL;
END
$$;
CREATE TRIGGER apply_stock_movement AFTER INSERT ON "stock_movement"
  FOR EACH ROW EXECUTE FUNCTION public.apply_stock_movement();

-- Inmutabilidad (ADR 0009 y 0013): donde hay historia nada se edita ni se borra, ni siquiera quien es dueno de la
-- tabla. Corregir es agregar otra fila que compense.
CREATE FUNCTION public.refuse_history_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: add a compensating row instead', TG_TABLE_NAME
    USING ERRCODE = 'integrity_constraint_violation';
END
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'stock_movement', 'operation', 'purchase', 'purchase_line', 'cash_movement', 'sale', 'sale_line', 'payment',
    'sale_void'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER refuse_history_change BEFORE UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION public.refuse_history_change()', t
    );
    EXECUTE format(
      'CREATE TRIGGER refuse_history_truncate BEFORE TRUNCATE ON %I
         FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_history_change()', t
    );
  END LOOP;
END $$;

-- La unidad de un producto no cambia si ya tiene movimientos (ADR 0015): 5 kilos no pueden pasar a ser 5 unidades.
-- Corre con los permisos de quien actualiza: ve los movimientos de SU negocio, que son los unicos que importan.
CREATE FUNCTION public.refuse_unit_change() RETURNS trigger
  LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
  IF NEW."unit" IS DISTINCT FROM OLD."unit" AND EXISTS (
    SELECT 1 FROM public.stock_movement m WHERE m.id_negocio = OLD.id_negocio AND m.product_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'The unit of a product with stock movements cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER refuse_unit_change BEFORE UPDATE OF "unit" ON "product"
  FOR EACH ROW EXECUTE FUNCTION public.refuse_unit_change();

REVOKE EXECUTE ON FUNCTION public.apply_stock_movement() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refuse_history_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.refuse_unit_change() FROM PUBLIC;

-- ===========================================================================================================
-- Permisos: la aplicacion hace lo minimo (ADR 0005). Quien tiene historia no se edita ni se borra.
-- ===========================================================================================================

GRANT USAGE ON SCHEMA public TO stock_app;
GRANT SELECT, INSERT, UPDATE ON "business", "branch", "app_user", "device", "device_counter", "product",
  "warehouse", "cash_shift" TO stock_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "category", "supplier" TO stock_app;
GRANT SELECT, INSERT ON "purchase", "purchase_line", "stock_movement", "operation", "cash_movement", "sale",
  "sale_line", "payment", "sale_void" TO stock_app;
-- La existencia solo la escribe el disparador.
GRANT SELECT ON "stock_balance" TO stock_app;

-- En Supabase, el esquema `public` entrega por omision permisos a los roles de su API de datos. Aqui nadie los usa:
-- la API se conecta directo a Postgres. Se quitan por si la Data API se encendiera por error.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM service_role;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM service_role;
  END IF;
END $$;
