-- Tipo tributario (ADR 0034).
--
-- Un 0 % puede ser exento o excluido y la tarifa no lo dice: para declarar hay que separarlos. El producto guarda el tipo y la linea de
-- venta lo copia, como copia el precio y la tarifa (ADR 0014 y 0027), y los dos lo validan contra la tarifa: gravado lleva 5 % o 19 %;
-- exento y excluido llevan 0 %.
--
-- Los datos que ya existen se marcan asi: 5 % y 19 % son gravados, sin duda; un 0 % queda EXENTO como VALOR DE ARRANQUE, no como
-- clasificacion, porque no hay forma de saber cual era. Es seguro hoy porque la base de produccion no existe todavia y PRE tiene datos
-- ficticios (ADR 0032 y 0034). Esta migracion la aplica UNA PERSONA (ADR 0010), nunca Claude.
--
-- La columna se llena sin UPDATE, por dos razones que esta migracion respeta:
--   * `sale_line` es historia inmutable (ADR 0009 y 0013): un disparador rechaza cualquier UPDATE, incluso del dueno. Agregar una
--     columna generada y quitarle despues la expresion reescribe la tabla sin disparar ese disparador y sin saltarselo.
--   * la seguridad por fila esta forzada (ADR 0005): el dueno, sin un negocio fijado, no veria ninguna fila y un UPDATE tocaria cero.
-- Al final la columna es una columna normal: `TEXT NOT NULL`, sin DEFAULT, para que ninguna escritura quede clasificada porque alguien
-- se olvido de decirlo.

-- Producto ------------------------------------------------------------------------------------------------------------------------
ALTER TABLE "product" ADD COLUMN "tax_kind" TEXT GENERATED ALWAYS AS (
  CASE WHEN "tax_rate_bp" > 0 THEN 'taxed' ELSE 'exempt' END
) STORED;
ALTER TABLE "product" ALTER COLUMN "tax_kind" DROP EXPRESSION;
ALTER TABLE "product" ALTER COLUMN "tax_kind" SET NOT NULL;
ALTER TABLE "product" ADD CONSTRAINT "product_tax_kind_fits_rate" CHECK (
  ("tax_kind" = 'taxed' AND "tax_rate_bp" IN (500, 1900))
  OR ("tax_kind" IN ('exempt', 'excluded') AND "tax_rate_bp" = 0)
);

-- Linea de venta ------------------------------------------------------------------------------------------------------------------
ALTER TABLE "sale_line" ADD COLUMN "tax_kind" TEXT GENERATED ALWAYS AS (
  CASE WHEN "tax_rate_bp" > 0 THEN 'taxed' ELSE 'exempt' END
) STORED;
ALTER TABLE "sale_line" ALTER COLUMN "tax_kind" DROP EXPRESSION;
ALTER TABLE "sale_line" ALTER COLUMN "tax_kind" SET NOT NULL;
ALTER TABLE "sale_line" ADD CONSTRAINT "sale_line_tax_kind_fits_rate" CHECK (
  ("tax_kind" = 'taxed' AND "tax_rate_bp" IN (500, 1900))
  OR ("tax_kind" IN ('exempt', 'excluded') AND "tax_rate_bp" = 0)
);

-- Las copias de lectura (ADR 0028) -------------------------------------------------------------------------------------------------
-- Los dispositivos bajan el catalogo por lo que cambio despues de su ultima descarga. Como a cada producto le nacio un dato, todos
-- cambiaron: sin esto, un telefono con el catalogo de ayer no sabria el tipo de ningun producto y sus ventas saldrian sin clasificar.
-- `product` no es historia, pero la seguridad por fila esta forzada: se suelta un instante, dentro de esta misma transaccion, para que
-- el dueno vea las filas, y se vuelve a forzar antes de terminar.
ALTER TABLE "product" NO FORCE ROW LEVEL SECURITY;
UPDATE "product" SET "updated_at" = now();
ALTER TABLE "product" FORCE ROW LEVEL SECURITY;
