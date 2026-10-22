-- Turnos de caja (ADR 0026).
--
-- Un turno lo abre una persona en un dispositivo y lo cierra ella misma o la gerencia. Esta migracion hace cumplir en la
-- base lo que el ADR decide, para que ni un descuido del codigo pueda romperlo.

-- Quien cerro el turno: la persona del turno o, con `shift:close-other`, alguien de la gerencia. La clave foranea es
-- compuesta como todas (ADR 0020): el cierre es de alguien del mismo negocio.
ALTER TABLE "cash_shift" ADD COLUMN "closed_by_user_id" UUID;

ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_id_negocio_closed_by_user_id_fkey"
  FOREIGN KEY ("id_negocio", "closed_by_user_id") REFERENCES "app_user"("id_negocio", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Un turno esta abierto o cerrado del todo: cerrarlo es poner de una vez la hora, el efectivo contado y quien lo cerro. Y
-- no se cierra antes de abrirse.
ALTER TABLE "cash_shift" ADD CONSTRAINT "cash_shift_closing_complete"
  CHECK (
    ("closed_at" IS NULL AND "counted_amount" IS NULL AND "closed_by_user_id" IS NULL)
    OR ("closed_at" IS NOT NULL AND "counted_amount" IS NOT NULL AND "closed_by_user_id" IS NOT NULL
        AND "closed_at" >= "opened_at")
  );

-- Un turno abierto por dispositivo y por persona. Dos personas pueden turnarse un dispositivo (cada una con el suyo
-- abierto), pero una persona no abre dos turnos en el mismo dispositivo. Prisma no expresa un indice parcial: vive aqui.
CREATE UNIQUE INDEX "cash_shift_one_open" ON "cash_shift"("id_negocio", "device_id", "user_id")
  WHERE "closed_at" IS NULL;
