# Permisos: qué puede hacer cada rol y qué funciona sin conexión

Quién puede hacer qué en un negocio, y qué se puede seguir haciendo cuando se cae el internet. La decisión y sus
razones están en el [ADR 0017](../adr/0017-roles-permisos-y-modo-sin-conexion.md); este documento es la tabla que
lee una persona.

> **La tabla es una copia de `ACTIONS` en `src/domain/model/role.ts`,** que es lo que ejecuta el sistema. Una prueba
> (`test/docs/permisos.spec.ts`) las compara fila por fila y falla si dicen cosas distintas. Si cambias una, cambia
> la otra en el mismo PR.
>
> **El cliente lee la misma tabla** en [`contract/permissions.json`](../../contract/permissions.json), que se genera del
> dominio con `npm run permissions` y que el frontend guarda en copia (ADR 0022): decide qué ofrecer con lo mismo que
> el servidor aplica.

> **Dónde se aplican las acciones de personas** (ADR 0023): invitar, renovar una invitación, listar y cambiar a una
> persona usan `user:manage-cashiers` si la persona es cajero y `user:manage-admins` si es administrador o dueño; para
> cambiar un rol hace falta poder con el de antes **y** con el de después. El negocio nunca se queda sin un dueño activo.

> **Dónde se aplican las acciones del catálogo** (ADR 0015): ver productos y categorías es `product:view`, de los tres
> roles; crear, cambiar y archivar es `product:manage`; cambiar el precio de un producto pide además `price:update`.

> **Dónde se aplican las acciones de proveedores y compras** (C2-06): la lista de proveedores y las compras (registrar,
> listar y ver) son `purchase:create`, de la gerencia; ver la bodega es `stock:view`, de los tres roles.

## Los tres roles

- **Dueño:** quien creó el negocio. Puede todo, incluidos los datos del negocio y las personas con más
  responsabilidad.
- **Administrador:** quien lleva el día a día. Ve todo el negocio, anula ventas, ajusta el inventario, maneja el
  catálogo y los precios y administra a los cajeros. **No** administra a otros administradores ni cambia roles, y
  **no** cambia los datos del negocio.
- **Cajero:** quien atiende el mostrador. Vende, cobra en efectivo, abre y cierra su propio turno y consulta
  existencias y precios. **No ve utilidades ni anula ventas**, y solo ve las ventas de su propio turno.

Cada rol puede todo lo que puede el rol anterior: lo que hace un cajero lo hace un administrador, y lo que hace un
administrador lo hace el dueño.

## La tabla

«Sin conexión» dice si la acción se puede hacer con el dispositivo sin internet. Lo decidió el dueño del proyecto:
**el trabajo del mostrador sigue; la administración espera la conexión.**

| Acción                 | Qué es                                                      | Dueño | Administrador | Cajero | Sin conexión |
| ---------------------- | ----------------------------------------------------------- | ----- | ------------- | ------ | ------------ |
| `sale:create`          | Registrar una venta                                         | Sí    | Sí            | Sí     | Sí           |
| `payment:collect-cash` | Cobrar en efectivo                                          | Sí    | Sí            | Sí     | Sí           |
| `shift:open`           | Abrir el turno de caja propio                               | Sí    | Sí            | Sí     | Sí           |
| `shift:close`          | Cerrar el turno propio y hacer el arqueo                    | Sí    | Sí            | Sí     | Sí           |
| `sale:view-own-shift`  | Ver las ventas del turno propio                             | Sí    | Sí            | Sí     | Sí           |
| `stock:view`           | Consultar existencias (de la copia local)                   | Sí    | Sí            | Sí     | Sí           |
| `product:view`         | Consultar el catálogo y los precios (de la copia local)     | Sí    | Sí            | Sí     | Sí           |
| `shift:close-other`    | Cerrar el turno de otra persona                             | Sí    | Sí            | —      | —            |
| `sale:view-all`        | Ver todas las ventas del negocio                            | Sí    | Sí            | —      | —            |
| `sale:void`            | Anular una venta                                            | Sí    | Sí            | —      | —            |
| `stock:adjust`         | Ajustar existencias                                         | Sí    | Sí            | —      | —            |
| `purchase:create`      | Registrar una compra de mercancía                           | Sí    | Sí            | —      | —            |
| `cash-movement:create` | Registrar un ingreso o un egreso de efectivo fuera de venta | Sí    | Sí            | —      | —            |
| `product:manage`       | Crear, editar y archivar productos                          | Sí    | Sí            | —      | —            |
| `price:update`         | Cambiar precios y tarifas de IVA                            | Sí    | Sí            | —      | —            |
| `report:sales`         | Ver los reportes de ventas                                  | Sí    | Sí            | —      | —            |
| `report:stock`         | Ver los reportes de inventario                              | Sí    | Sí            | —      | —            |
| `report:profit`        | Ver utilidades                                              | Sí    | Sí            | —      | —            |
| `user:manage-cashiers` | Crear y dar de baja cajeros                                 | Sí    | Sí            | —      | —            |
| `user:manage-admins`   | Crear y dar de baja administradores y cambiar roles         | Sí    | —             | —      | —            |
| `business:settings`    | Cambiar los datos del negocio                               | Sí    | —             | —      | —            |
| `device:enroll`        | Registrar el dispositivo en el que se trabaja               | Sí    | Sí            | Sí     | —            |
| `device:revoke`        | Dar de baja un dispositivo                                  | Sí    | Sí            | —      | —            |

## Cómo se aplica

- **Se niega por omisión.** Una acción o un rol que no están en la tabla no pueden nada.
- **El negocio manda antes que el rol.** Ni el dueño de un negocio puede tocar nada de otro: `authorize` lo niega
  antes de mirar el rol (ADR 0005).
- **Una persona dada de baja no puede nada,** aunque su rol lo permita.
- **Sin conexión,** el dispositivo solo ofrece lo que la tabla marca con «Sí» y el servidor lo vuelve a comprobar
  cuando llega. Todo lo que se puede hacer sin conexión está abierto a los tres roles, para que un cambio de rol
  hecho mientras el dispositivo estaba sin red no bloquee una venta que ya ocurrió.
- **Qué pasa con lo que se hizo antes de enterarse de una baja:** una venta de alguien que ya estaba dado de baja
  cuando el servidor la recibe se **acepta** y se marca para el dueño. La mercancía ya salió (ADR 0009).
