-- Revision de ventas (ADR 0027).
--
-- La bandeja «Requiere atencion» junta las ventas que el servidor acepto con algo raro. Quien la gestiona las revisa, y revisar
-- NO cambia la venta: agrega una fila aparte, quien la miro y cuando. Asi la venta sigue siendo historia inmutable (ADR 0009 y
-- 0013) y sus marcas se conservan. Una venta se revisa una sola vez.

CREATE TABLE "sale_review" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "id_negocio" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "sale_review_pkey" PRIMARY KEY ("id")
);

-- Una venta se revisa una vez: la segunda revision no entra, y quien la intenta recibe la primera.
CREATE UNIQUE INDEX "sale_review_sale_unique" ON "sale_review"("id_negocio", "sale_id");

-- Claves foraneas compuestas, como todas (ADR 0020): la revision es de una venta y de una persona del mismo negocio.
ALTER TABLE "sale_review" ADD CONSTRAINT "sale_review_id_negocio_fkey" FOREIGN KEY ("id_negocio") REFERENCES "business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale_review" ADD CONSTRAINT "sale_review_id_negocio_sale_id_fkey" FOREIGN KEY ("id_negocio", "sale_id") REFERENCES "sale"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sale_review" ADD CONSTRAINT "sale_review_id_negocio_user_id_fkey" FOREIGN KEY ("id_negocio", "user_id") REFERENCES "app_user"("id_negocio", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Una nota corta y de una linea, o ninguna.
ALTER TABLE "sale_review" ADD CONSTRAINT "sale_review_note_shape"
  CHECK ("note" IS NULL OR (char_length("note") BETWEEN 1 AND 200 AND "note" !~ '[[:cntrl:]]'));

-- Seguridad por fila (ADR 0005): habilitada y forzada, con la misma politica que el resto de las tablas del negocio.
ALTER TABLE "sale_review" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sale_review" FORCE ROW LEVEL SECURITY;
CREATE POLICY business_isolation ON "sale_review"
  USING ("id_negocio" = nullif(current_setting('app.id_negocio', true), '')::uuid)
  WITH CHECK ("id_negocio" = nullif(current_setting('app.id_negocio', true), '')::uuid);

-- Inmutabilidad (ADR 0009 y 0013): una revision no se edita ni se borra, ni siquiera quien es dueno de la tabla.
CREATE TRIGGER refuse_history_change BEFORE UPDATE OR DELETE ON "sale_review"
  FOR EACH ROW EXECUTE FUNCTION public.refuse_history_change();
CREATE TRIGGER refuse_history_truncate BEFORE TRUNCATE ON "sale_review"
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_history_change();

-- La aplicacion solo agrega y lee.
GRANT SELECT, INSERT ON "sale_review" TO stock_app;
