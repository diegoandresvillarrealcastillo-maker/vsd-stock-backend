-- Ventas (ADR 0027).
--
-- Una venta casi siempre ya ocurrio en un mostrador, a veces sin conexion: el servidor la acepta y, si algo no cuadra con lo
-- que el sabe, la guarda marcada. Esta migracion le da a la venta donde guardar esas marcas y a sus lineas y cobros el orden
-- en que el dispositivo los vendio. Las tablas de ventas siguen siendo solo de agregar (sin UPDATE ni DELETE).

-- Las marcas que el servidor le pone a la venta (las de la hora viven en la operacion, ADR 0016). La lista es cerrada: una
-- marca nueva es un cambio de esta restriccion y de `SALE_FLAGS` en el dominio.
ALTER TABLE "sale" ADD COLUMN "flags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "sale" ADD CONSTRAINT "sale_flags_known"
  CHECK ("flags" <@ ARRAY['price-differs', 'total-differs', 'payment-mismatch', 'late-shift', 'revoked-device', 'folio-device']::TEXT[]);

-- El folio es corto: `AA-000142`, y con un conflicto `AA-000142~0a1b2c3d`.
ALTER TABLE "sale" ADD CONSTRAINT "sale_folio_shape"
  CHECK (char_length("folio") BETWEEN 1 AND 60 AND char_length("folio_reported") BETWEEN 1 AND 40);

-- El orden de las lineas y de los cobros: sin esto, las filas vuelven en el orden de sus identificadores al azar y el
-- comprobante se desordenaria al consultarlo.
ALTER TABLE "sale_line" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "payment" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "sale_line" ADD CONSTRAINT "sale_line_position_range" CHECK ("position" BETWEEN 0 AND 199);
ALTER TABLE "payment" ADD CONSTRAINT "payment_position_range" CHECK ("position" BETWEEN 0 AND 9);
