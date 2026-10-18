-- Invitaciones (ADR 0023).
--
-- Una invitacion pendiente es una fila de `app_user` sin `auth_user_id` que guarda el hash del codigo (ADR 0021,
-- punto 9). Quien la canjea todavia no pertenece a ningun negocio, asi que no puede fijar `app.id_negocio` ni la
-- seguridad por fila le dejaria ver la fila. Estas dos politicas, que se SUMAN a las que ya existen, le dejan ver y
-- tomar UNA fila: la del hash que demuestra conocer.

-- El hash del codigo es unico en TODA la base, no por negocio: quien canjea no dice a que negocio va. Los NULL no
-- cuentan como iguales, asi que las personas ya ligadas (sin hash) no estorban.
CREATE UNIQUE INDEX "app_user_invitation_hash_key" ON "app_user"("invitation_hash");

-- Ver la fila: solo si es una invitacion sin canjear y el hash coincide con el que la transaccion fijo.
CREATE POLICY invitation_lookup ON "app_user" FOR SELECT
  USING (
    "auth_user_id" IS NULL
    AND "invitation_hash" = nullif(current_setting('app.invitation_hash', true), '')
  );

-- Tomarla: la misma fila, sin canjear, de alguien dado de alta y vigente; y despues del cambio la fila queda ligada a
-- la identidad que la transaccion declaro (`app.auth_user_id`) y a ninguna otra.
CREATE POLICY invitation_redeem ON "app_user" FOR UPDATE
  USING (
    "auth_user_id" IS NULL
    AND "active"
    AND "invitation_expires_at" > now()
    AND "invitation_hash" = nullif(current_setting('app.invitation_hash', true), '')
  )
  WITH CHECK (
    "auth_user_id" = nullif(current_setting('app.auth_user_id', true), '')::uuid
  );
