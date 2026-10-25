-- Folio propio de las anulaciones (ADR 0036).
--
-- Una anulacion es un hecho del negocio y necesita su propio numero para poder nombrarla en una nota, en el cierre de caja o frente a un
-- contador. Hasta hoy solo tenia el folio de la venta que anulaba. Cada anulacion recibe un numero por negocio (1, 2, 3...), sin saltos y
-- en el orden en que se anotaron, y se escribe `ANU-000001`. El numero lo da el servidor al anotar la anulacion, dentro de la misma
-- transaccion, desde un contador por negocio; una anulacion rechazada no gasta ninguno.
--
-- Las anulaciones que ya existen se numeran por negocio, en el orden de la hora en que se anotaron y, si empatan, por su identificador. El
-- contador de cada negocio arranca despues del ultimo numero dado, y los negocios sin anulaciones no tienen fila: nace con la primera.
-- Esta migracion la aplica UNA PERSONA (ADR 0010), nunca Claude.
--
-- Numerar las filas que ya existen exige un UPDATE sobre `sale_void`, y `sale_void` es historia inmutable (ADR 0009 y 0013): un disparador
-- rechaza cualquier UPDATE, incluso del dueno. La columna no puede ser generada (una expresion generada solo ve su propia fila, y el
-- numero depende de las demas), asi que esta migracion hace dos cosas, las dos DENTRO de esta transaccion y las dos revertidas antes de
-- terminar:
--   * apaga el disparador `refuse_history_change` de `sale_void` solo mientras corre el UPDATE;
--   * suelta la seguridad por fila forzada de `sale_void` solo mientras corre el UPDATE (el dueno, sin un negocio fijado, no veria ninguna
--     fila y el UPDATE tocaria cero).
-- Al terminar el disparador esta activo, la seguridad por fila esta habilitada y forzada, y `number` es una columna normal: `INTEGER NOT
-- NULL`, sin DEFAULT, para que ninguna anulacion quede sin numero porque alguien se olvido de dar uno. El UPDATE solo escribe `number`.

-- El contador de cada negocio ----------------------------------------------------------------------------------------------------
-- `next_number` es el SIGUIENTE numero por dar: la fila nace con la primera anulacion (con 2, porque el 1 ya se dio) y nunca baja de 2.
-- Se crea primero y sin seguridad por fila para llenarlo en la misma ventana en que se numeran las anulaciones que ya existen.
CREATE TABLE "void_counter" (
    "id_negocio" UUID NOT NULL,
    "next_number" INTEGER NOT NULL,

    CONSTRAINT "void_counter_pkey" PRIMARY KEY ("id_negocio")
);

ALTER TABLE "void_counter" ADD CONSTRAINT "void_counter_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "void_counter" ADD CONSTRAINT "void_counter_positive" CHECK ("next_number" >= 2);

-- El numero de cada anulacion -----------------------------------------------------------------------------------------------------
ALTER TABLE "sale_void" ADD COLUMN "number" INTEGER;

-- La ventana: con el disparador apagado y la seguridad por fila suelta se numera y se llena el contador (que lee `sale_void` y, con la
-- seguridad forzada, no veria ninguna fila). Se cierra en cuanto termina.
ALTER TABLE "sale_void" DISABLE TRIGGER "refuse_history_change";
ALTER TABLE "sale_void" NO FORCE ROW LEVEL SECURITY;

UPDATE "sale_void" AS v
   SET "number" = numbered."number"
  FROM (
    SELECT "id", row_number() OVER (PARTITION BY "id_negocio" ORDER BY "created_at", "id")::integer AS "number"
      FROM "sale_void"
  ) AS numbered
 WHERE v."id" = numbered."id";

INSERT INTO "void_counter" ("id_negocio", "next_number")
SELECT "id_negocio", max("number") + 1 FROM "sale_void" GROUP BY "id_negocio";

ALTER TABLE "sale_void" FORCE ROW LEVEL SECURITY;
ALTER TABLE "sale_void" ENABLE TRIGGER "refuse_history_change";

ALTER TABLE "sale_void" ALTER COLUMN "number" SET NOT NULL;
ALTER TABLE "sale_void" ADD CONSTRAINT "sale_void_number_positive" CHECK ("number" >= 1);
CREATE UNIQUE INDEX "sale_void_number_unique" ON "sale_void"("id_negocio", "number");

-- La seguridad por fila y los permisos del contador (ADR 0005) -----------------------------------------------------------------------
ALTER TABLE "void_counter" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "void_counter" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_isolation ON "void_counter"
  USING ("id_negocio" = nullif(current_setting('app.id_negocio', true), '')::uuid)
  WITH CHECK ("id_negocio" = nullif(current_setting('app.id_negocio', true), '')::uuid);

-- Como `device_counter`: la aplicacion lo lee, lo crea y lo actualiza; nunca lo borra.
GRANT SELECT, INSERT, UPDATE ON "void_counter" TO stock_app;
