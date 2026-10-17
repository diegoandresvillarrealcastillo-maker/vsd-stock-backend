# ADR 0017 — Tres roles, permisos que se niegan por omisión y un mostrador que sigue sin conexión

- **Estado:** Aceptada
- **Fecha:** 2026-10-17
- **Ciclo:** 1

## Contexto

Dos preguntas del [mapa de contextos](../dominio/mapa-de-contextos.md) quedaron abiertas:

- **¿Qué puede hacer exactamente cada rol?** El glosario nombra tres (dueño, administrador y cajero) y el encargo
  fija un solo permiso: _un cajero no ve utilidades ni borra ventas_. El [ADR 0007](0007-vitest-pruebas-primero-y-cobertura.md)
  exige además una prueba en negativo por cada regla de autorización: no basta con que el dueño pueda, hay que
  probar que quien no debe, no puede.
- **¿Qué se puede y qué no se puede hacer sin conexión, funcionalidad por funcionalidad?** Un cajero no puede dejar
  de vender porque se cayó el internet, pero no todo debe poder hacerse a ciegas.

**Decisión del dueño del proyecto (`APROBADO CICLO 1`, 2026-10-16):** _la operación de mostrador (vender, cobrar
en efectivo, turnos y consulta de existencias locales) funciona sin red; administración, catálogo, precios,
usuarios y reportes requieren conexión._

## Decisión

1. **Hay tres roles:** dueño (`owner`), administrador (`admin`) y cajero (`cashier`). No son configurables.
2. **Las acciones son una lista cerrada** de 23, con nombre `área:qué` (`sale:create`, `sale:void`,
   `stock:adjust`...), y la **única fuente** es la constante `ACTIONS` de
   [`src/domain/model/role.ts`](../../src/domain/model/role.ts): para cada acción, qué roles la tienen y si se puede
   hacer sin conexión. La tabla que lee una persona está en [`docs/dominio/permisos.md`](../dominio/permisos.md) y
   **una prueba la compara con el código fila por fila**.
3. **Los permisos solo crecen con la responsabilidad:** lo que hace un cajero lo hace un administrador, y lo que
   hace un administrador lo hace el dueño. Una prueba lo recorre.
4. **Se niega por omisión.** Un rol, una acción o un nombre que no están en la tabla no pueden nada, ni siquiera
   `toString` o `__proto__`.
5. **`authorize` decide, y revisa en este orden:** (1) la acción no existe; (2) la persona fue dada de baja; (3) lo
   que toca es **de otro negocio**, sea cual sea su rol; (4) su rol no la permite; (5) su rol la permite pero hace
   falta conexión y no hay. El negocio se revisa antes que el rol: ni el dueño de otro negocio pasa (ADR 0005), y
   una negativa no revela más de lo necesario. El servidor la usa siempre con `online: true`; el dispositivo, para
   no ofrecer lo que no puede hacer.
6. **El cajero** vende, cobra en efectivo, abre y cierra **su** turno, ve las ventas de **su** turno y consulta
   existencias y precios. **No** ve utilidades, no anula ventas, no ve las ventas de todo el negocio, no ajusta el
   inventario, no cambia productos ni precios, no mueve efectivo fuera de una venta, no ve reportes y no
   administra personas ni dispositivos.
7. **El administrador** puede todo lo del día a día: ver todo el negocio, anular ventas, ajustar existencias,
   registrar compras, manejar el catálogo y los precios, ver reportes y utilidades, y administrar **cajeros** y
   dispositivos. **No** administra a otros administradores ni cambia roles, y **no** cambia los datos del negocio:
   eso es del dueño, para que no haya un camino de ascenso de privilegios que pase por un administrador.
8. **Sin conexión funcionan siete acciones:** registrar una venta, cobrar en efectivo, abrir y cerrar el turno
   propio, ver las ventas del turno propio y consultar existencias y catálogo (de la copia local). Todo lo demás
   necesita conexión, y también **registrar un dispositivo**.
9. **Todo lo que funciona sin conexión está abierto a los tres roles.** Así, un cambio de rol hecho mientras un
   dispositivo estaba sin red no puede bloquear una venta que ya ocurrió ni obligar a decidir con un rol viejo. Una
   prueba lo exige.
10. **El servidor vuelve a comprobar lo que llega.** Para una operación hecha sin conexión basta que la persona
    pertenezca al negocio. Si **fue dada de baja** (o su dispositivo se revocó) antes de que el dispositivo se
    enterara, **la venta se acepta y se marca** para el dueño, porque la mercancía ya salió del mostrador (ADR
    0009). La baja surte efecto en el dispositivo cuando este se entera.
11. **Anular una venta necesita conexión y un administrador.** Una venta confirmada no se edita ni se borra; se
    compensa (ADR 0009). Un error de cobro en medio de un apagón se corrige cuando vuelve la conexión.
12. **Registrar el dispositivo lo hace cualquier persona con sesión**, porque sin eso no se puede vender sin
    conexión (ADR 0016); darlo de baja es de un administrador.

### Lo que NO se decide aquí

- **Cómo se identifica a la persona y se verifica el token** (Ciclo 2) ni cuánto dura una sesión sin conexión.
- **Hay siempre al menos un dueño,** y no se puede dar de baja al último: es una regla para el Ciclo 2, que no se
  puede probar sin usuarios reales.
- **Permisos por persona o roles configurables.**
- **Las utilidades:** `report:profit` queda definido y negado al cajero, pero el catálogo todavía no guarda
  costos (ADR 0015), así que no hay nada que calcular.

## Alternativas consideradas

### Roles y permisos configurables por negocio

Cada negocio armaría los suyos. Es más flexible y es mucho más: pantallas, migraciones, pruebas por combinación y
un camino de ascenso de privilegios nuevo. Para una tienda de barrio, tres roles fijos bastan.

### Que el cajero pueda anular su propia venta dentro del turno

Es lo que hacen muchas cajas y evita llamar a un administrador. Contradice el encargo («no borra ventas») y la
razón de fondo: quien cobra no debería poder deshacer el cobro.

### Permitir también la administración sin conexión

Un administrador que cambia un precio o ajusta existencias en un dispositivo sin red crea cambios que otro
dispositivo puede contradecir, y el dueño del proyecto decidió dejar la administración con conexión.

### No permitir nada sin conexión

Es lo que se quiere evitar: el negocio dejaría de vender con cada corte de internet.

### Decidir los permisos en la base de datos o en los controladores

Los permisos son una regla de negocio y viven en `domain/` (ADR 0003), donde se prueban sin levantar nada. Los
controladores y la interfaz solo consultan `authorize`.

## Consecuencias

### A favor

- **Una sola tabla** que ejecuta el sistema y que una persona puede leer, sin que se desfasen.
- **Una prueba en negativo por regla** (17), más la de «ningún negocio ve a otro» para los tres roles y las 23
  acciones.
- El mostrador no se detiene por una caída de red, y el dispositivo sabe qué ofrecer.

### En contra

- **Un error de cobro en un apagón no se puede corregir hasta que vuelve la conexión**, y un administrador no puede
  ajustar existencias en ese lapso.
- **Los permisos no son configurables:** un negocio que quiera que su cajero anule ventas, o que un administrador
  administre administradores, no puede.
- **Son 23 acciones.** Cada una nueva exige tocar el código, la tabla y las pruebas en el mismo PR.
- **Un cajero puede registrar su teléfono personal como dispositivo.** Se mitiga con la baja de dispositivos, la
  marca de cada operación con su dispositivo y la auditoría, no impidiéndolo.
- **Una baja no llega a un dispositivo sin conexión hasta que sincroniza:** hasta entonces, esa persona puede
  seguir vendiendo desde él, y se marca lo que venda.
- **`report:profit` es un permiso sin funcionalidad todavía.**
- **El rol que ve un dispositivo sin conexión puede estar atrasado.** No importa para las siete acciones del
  mostrador, que son de todos, pero sí para cualquier acción futura que se abra sin conexión: antes de abrir una
  exige revisar este punto.

### Mitigación acordada

- La prueba que compara `permisos.md` con `ACTIONS` falla si una tabla se actualiza sin la otra.
- El Ciclo 2 debe probar, con usuarios reales, que otro negocio es rechazado en cada caso de uso y que no se puede
  dar de baja al último dueño.
- Antes de la entrega se revisa la tabla con una persona que atienda un mostrador de verdad.
