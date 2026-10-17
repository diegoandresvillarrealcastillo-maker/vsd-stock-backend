# Glosario del dominio de VSD Stock

El vocabulario del negocio, en español, con el nombre que tiene cada cosa en el código. Sirve para que quien
escribe una historia de usuario, una prueba o un documento use la misma palabra para la misma cosa.

> **Este glosario no congela el modelo.** Casi todo lo que sigue es un punto de partida que se valida y se
> congela en el Ciclo 1 con un ADR. Por eso cada término dice en qué estado está, y un término en
> _Hipótesis_ puede cambiar de nombre, de forma o desaparecer. El [mapa de contextos](mapa-de-contextos.md)
> agrupa estos términos en las partes del sistema.

## Cómo leerlo

**Estado de cada término:**

| Estado        | Qué significa                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Decidido**  | Está escrito en un ADR. No cambia sin otro ADR que lo reemplace.                                                       |
| **Requisito** | Lo pidió el encargo inicial o el dueño del proyecto, pero todavía no tiene ADR. Se fija en el ciclo que lo implemente. |
| **Hipótesis** | Punto de partida para validar en el Ciclo 1. Nadie debe construir encima como si fuera definitivo.                     |

**Idioma:** los documentos y los textos para la persona usuaria van en español; el código y sus identificadores,
en inglés. La columna **Código** de cada término dice cómo se llama en el código (`—` si no tiene).
La única regla de nombres en la base de datos que ya está decidida es la columna `id_negocio` (ADR 0005); el
resto de nombres se decide en el Ciclo 1.

**Alcance de la entrega:** donde un término dice _fuera de la entrega_, el concepto existe en el vocabulario pero
no se construye antes del 2026-11-16 (ver el mapa de contextos).

## Identidad y acceso

### Negocio

La empresa que usa VSD Stock: una tienda, un restaurante, una ferretería. Todo dato pertenece a un negocio y un
negocio nunca ve los datos de otro. El negocio sale del token verificado, no de lo que declare el cliente.

**Código:** `Business` (en la base de datos, `id_negocio`)

**Estado:** Decidido (ADR 0005)

### Sucursal

Un local físico de un negocio. Se modela desde el inicio para no rehacer el modelo después, pero la entrega
opera con una sola por negocio.

**Código:** `Branch`

**Estado:** Hipótesis

### Usuario

Una persona con acceso a un negocio. Cómo se identifica (Supabase Auth y la verificación del token contra su
JWKS) se decide en el Ciclo 2.

**Código:** `User`

**Estado:** Hipótesis

### Rol

Lo que una persona puede hacer en un negocio. Son tres, fijos: **dueño**, **administrador** y **cajero**. Un cajero
no ve utilidades ni anula ventas. Cada acción tiene su tabla de quién la puede hacer y si funciona sin conexión
([Permisos](permisos.md)); se niega por omisión y el negocio se revisa antes que el rol. Los permisos son una regla
de negocio que vive en `domain/`, con una prueba en negativo por cada regla: no basta que el dueño acceda, otro
negocio debe ser rechazado (ADR 0017).

**Código:** `Role`, `Action` y `authorize`

**Estado:** Decidido (ADR 0017)

### Dispositivo

El equipo en el que corre la aplicación: un teléfono, una tablet o un computador. Guarda la base local de cada
persona que lo usa y puede ser compartido entre varias. Se registra con conexión la primera vez y el servidor le
da un código corto, único en su negocio y que nunca se reutiliza (`AA`, `AB`...); ese código encabeza sus folios
(ADR 0016).

**Código:** `Device` y `DeviceCode`

**Estado:** Decidido (ADR 0016)

### Sesión

El periodo en que una persona está identificada en un dispositivo. Una sesión caducada conserva lo guardado en
el dispositivo, cerrado; cerrar sesión lo borra.

**Código:** `Session`

**Estado:** Requisito

## Catálogo

### Producto

Lo que el negocio vende o compra: «Arroz 500 g». Tiene un nombre, un SKU, un código de barras opcional, una
unidad de medida, un precio con el IVA incluido y la tarifa de ese IVA. Cada presentación (unidad, paca, caja) es
otro producto. Un producto con historial no se borra: se archiva y conserva sus códigos (ADR 0015).

**Código:** `Product`

**Estado:** Decidido (ADR 0015)

### Variante

Una presentación distinta del mismo producto (talla, color, tamaño). **No existe en la entrega:** cada
presentación es un producto independiente con su propio código, sin conversión entre ellas (ADR 0015).

**Código:** `Variant`

**Estado:** Decidido (ADR 0015)

### Categoría

Agrupación de productos para encontrarlos y reportarlos: «Granos», «Aseo».

**Código:** `Category`

**Estado:** Hipótesis

### Unidad de medida

Cómo se cuenta un producto, en un conjunto cerrado: unidad, kilo, gramo, libra, litro y mililitro. No hay caja,
paca ni docena (serían otro producto). La cantidad es un entero de milésimas de la unidad, y la unidad se cuenta
solo en enteros (ADR 0015).

**Código:** `UnitOfMeasure` y `Quantity`

**Estado:** Decidido (ADR 0015)

### Precio

Cuánto cuesta un producto al venderlo, en pesos enteros y **con el IVA incluido**. Es dinero (ver _Dinero_). La
línea de venta guarda el precio y la tarifa que tenían en ese momento, no una referencia que pueda cambiar
después (ADR 0014).

**Código:** `Price`

**Estado:** Decidido (ADR 0014)

### Impuesto

El gravamen incluido en el precio (en Colombia, el IVA), con una tarifa **por producto**: 0 %, 5 % o 19 %. El
sistema lo desglosa del total, no lo suma, y se redondea de una sola manera para que la base más el IVA sea
siempre el total (ADR 0014). La entrega calcula impuestos pero no emite factura electrónica (DIAN). Las tarifas y
la mecánica frente a la norma son una hipótesis que debe verificar quien lleve la contabilidad.

**Código:** `Tax`

**Estado:** Decidido (ADR 0014)

### Código de barras

El identificador impreso en el empaque que lee el lector o la cámara del dispositivo. Es opcional, de 8, 12, 13 o
14 dígitos y con el dígito de control comprobado; el UPC-A y el EAN-13 que le antepone un cero son el mismo
código, y es único por negocio. La entrega soporta lector de código de barras y cámara, sin impresora (ADR 0015).

**Código:** `Barcode`

**Estado:** Decidido (ADR 0015)

### SKU

El identificador interno de un producto dentro de un negocio, el que el negocio le da a su mercancía. Es
obligatorio, de 1 a 40 caracteres, y único por negocio sin distinguir mayúsculas (ADR 0015).

**Código:** `Sku`

**Estado:** Decidido (ADR 0015)

## Inventario

### Bodega

El lugar donde está la mercancía de un negocio. Se modela desde el inicio, pero la entrega opera con una sola.

**Código:** `Warehouse`

**Estado:** Hipótesis

### Movimiento de stock

Un registro **inmutable** de que la existencia de un producto subió o bajó, con su motivo: venta, compra, ajuste,
devolución. El inventario es un libro de movimientos, no un número que se sobrescribe. Corregir es agregar otro
movimiento que compensa; nunca se edita.

**Código:** `StockMovement`

**Estado:** Decidido (ADR 0009)

### Existencia

Cuánta mercancía hay de un producto: la **suma** de sus movimientos de stock. Se lee de un saldo por producto
que mantiene un disparador de la base de datos en la misma transacción que el movimiento; la aplicación solo lo
lee, y la suma de los movimientos sigue siendo la verdad (ADR 0013).

**Código:** `StockOnHand`

**Estado:** Decidido (ADR 0009 y ADR 0013)

### Requiere ajuste

La marca que lleva una venta aceptada al sincronizar que dejó la existencia en negativo. La mercancía ya salió
del mostrador, así que la venta **nunca se rechaza**: el servidor la acepta, la marca y avisa al dueño o al
administrador (no al cajero).

**Código:** `NeedsAdjustment`

**Estado:** Decidido (ADR 0009)

### Ajuste

Un movimiento de stock que corrige la existencia (mercancía dañada, un conteo, un error). Reemplaza editar.

**Código:** `Adjustment`

**Estado:** Hipótesis

### Compra

La entrada de mercancía que se le compra a un proveedor. Genera movimientos de stock de entrada.

**Código:** `Purchase`

**Estado:** Hipótesis

### Proveedor

A quien el negocio le compra la mercancía.

**Código:** `Supplier`

**Estado:** Hipótesis

### Alerta de stock mínimo

El aviso de que la existencia de un producto bajó del mínimo que el negocio fijó. Si el plazo aprieta, se
recorta después de la mascota y de los reportes.

**Código:** `LowStockAlert`

**Estado:** Hipótesis

### Conteo físico

Contar la mercancía real y compararla con la existencia del sistema. Fuera de la entrega.

**Código:** `PhysicalCount`

**Estado:** Hipótesis

## Ventas

### Venta

La transacción en el mostrador: qué se vendió, a qué precio y cómo se pagó. Una venta ya hecha **nunca se
rechaza al sincronizar** (ver _Requiere ajuste_); solo se rechaza lo inválido de verdad: negocio distinto,
firma inválida o forma ilegible.

**Código:** `Sale`

**Estado:** Hipótesis

### Línea de venta

Un producto, una cantidad y su precio dentro de una venta.

**Código:** `SaleLine`

**Estado:** Hipótesis

### Pago

Con qué se cobró una venta. La entrega acepta efectivo y el **registro manual** de tarjeta o transferencia, sin
pasarela de pagos.

**Código:** `Payment`

**Estado:** Hipótesis

### Descuento

Una rebaja sobre una línea o sobre toda la venta.

**Código:** `Discount`

**Estado:** Hipótesis

### Anulación

Dejar sin efecto una venta ya registrada. No borra ni edita nada: agrega los movimientos que compensan, de
stock y de caja.

**Código:** `SaleVoid`

**Estado:** Decidido (ADR 0009)

### Devolución

Que el cliente regresa mercancía. Las devoluciones parciales quedan fuera de la entrega.

**Código:** `Return`

**Estado:** Hipótesis

### Cliente

A quien se le vende. Es opcional: una venta de mostrador puede no tener cliente.

**Código:** `Customer`

**Estado:** Hipótesis

### Fiado

Vender ahora y cobrar después, y las cuentas por cobrar que eso genera. Fuera de la entrega.

**Código:** `CustomerCredit`

**Estado:** Hipótesis

## Caja

### Turno de caja

El periodo entre que una persona abre la caja y la cierra. Todo cobro en efectivo ocurre dentro de un turno.

**Código:** `CashShift`

**Estado:** Hipótesis

### Arqueo

Al cerrar el turno, comparar el efectivo que **debería haber** (apertura, más cobros, menos egresos) con el
que **se cuenta**. La diferencia queda registrada.

**Código:** `CashCount`

**Estado:** Hipótesis

### Movimiento de caja

Un ingreso o un egreso de efectivo que no es una venta: pagar al repartidor, retirar para el banco.

**Código:** `CashMovement`

**Estado:** Hipótesis

### Folio

El número con que se identifica una venta ante la persona: el código del dispositivo que la hizo y la serie de ese
dispositivo, como `AA-000142`. Dos cajas sin conexión no pueden repetirlo porque sus códigos son distintos. No
cambia al sincronizar, no ordena las ventas entre dispositivos (para eso está la hora) y puede tener saltos
(ADR 0016).

**Código:** `Folio`

**Estado:** Decidido (ADR 0016)

## Finanzas y reportes

### Flujo de caja

Cuánto dinero entró y salió en un periodo. Se **deriva** de las ventas y los movimientos de caja; no es una tabla
que alguien escribe. El flujo de caja completo queda fuera de la entrega; los reportes mínimos sí entran.

**Código:** `CashFlow`

**Estado:** Hipótesis

### Gasto

Lo que el negocio paga para operar: arriendo, servicios, nómina. Fuera de la entrega.

**Código:** `Expense`

**Estado:** Hipótesis

### Cuenta por cobrar y por pagar

Lo que a un negocio le deben (clientes) y lo que debe (proveedores). Fuera de la entrega.

**Código:** `Receivable` y `Payable`

**Estado:** Hipótesis

### Reporte

Una vista **derivada** del libro de movimientos y de las ventas: ventas por día, productos más vendidos,
existencias. Nunca una tabla escrita a mano.

**Código:** `Report`

**Estado:** Requisito

## Sincronización y conexión

### Operación

Algo que la persona hizo en el dispositivo y que falta enviar al servidor: una venta, un movimiento de stock, la
apertura de un turno. Se guarda en la cola hasta que el servidor la confirma.

**Código:** `Operation`

**Estado:** Decidido (ADR 0009)

### operationId

El identificador de una operación: un UUID que se crea **una sola vez** y no cambia. El servidor lo usa como
clave de idempotencia por negocio, así que reenviar una operación tras perder la respuesta devuelve lo que ya
existe y no crea nada dos veces.

**Código:** `operationId`

**Estado:** Decidido (ADR 0009)

### Cola de operaciones

Lo que se hizo en el dispositivo y falta enviar. Junto con las copias de lectura, es lo único que se guarda en el
dispositivo.

**Código:** `OperationQueue`

**Estado:** Decidido (ADR 0009)

### Copia de lectura

Una copia local de datos que la persona necesita para trabajar sin red: el catálogo, las existencias, los
precios, los clientes.

**Código:** `ReadCopy`

**Estado:** Decidido (ADR 0009)

### Sincronización

Enviar la cola al servidor y traer lo nuevo. Es idempotente y ocurre **una a la vez** aunque haya varias
pestañas abiertas (Web Locks).

**Código:** `Sync`

**Estado:** Decidido (ADR 0009)

### Estado de conexión

Lo que la persona ve de la conexión, siempre honesto: _en línea_, _sin conexión_, _sincronizando_, _N
pendientes_ y _requiere atención_. Nunca se dice «guardado» si solo está en el dispositivo. El frontend
implementa _comprobando_, _en línea_ y _sin conexión_ desde el ticket C0-08; el resto llega con el motor de
sincronización.

**Código:** `ConnectionStatus`

**Estado:** Decidido (ADR 0009)

### Comprobación de salud

`GET /health`: la pregunta que confirma que el servidor está en pie. **Es lo que decide si hay conexión;**
`navigator.onLine` solo es una pista de cuándo preguntar.

**Código:** `HealthReport`

**Estado:** Decidido (ADR 0009)

### Clase de fallo

Cómo se trata un fallo al sincronizar: **red** (se detiene todo), **sesión** (se detiene todo y la cola se
conserva), **pasajero** (espera creciente), **conflicto** (se marca, no se pisa nada) y **permanente** (se marca
para atención sin bloquear a las demás).

**Código:** `FailureClass`

**Estado:** Decidido (ADR 0009)

## Dinero y reglas transversales

### Dinero

Una cantidad con su moneda. **Nunca un `float`**: un entero de pesos, sin centavos, en un objeto de valor
inmutable. Hay una sola regla de redondeo (la mitad exacta se aleja de cero) y los cálculos se prueban con
vectores que comparten el backend y el frontend (ADR 0014).

**Código:** `Money`

**Estado:** Decidido (ADR 0014)

### Moneda

El peso colombiano (COP). La entrega es para Colombia y no maneja otra moneda (ADR 0014).

**Código:** `Currency`

**Estado:** Decidido (ADR 0014)

### Auditoría

Las ventas, las anulaciones y los ajustes son inmutables: lo que pasó queda escrito y corregirlo es agregar un
movimiento que compensa, no editar.

**Código:** —

**Estado:** Requisito

### Datos personales

La Ley 1581 de Colombia: consentimiento, exportación y eliminación de los datos de una persona, y nada de datos
personales en los registros ni en las direcciones. Exportar y eliminar la cuenta queda fuera de la entrega, como
deuda con su ADR.

**Código:** —

**Estado:** Requisito

## Arquitectura y proceso

### Contrato OpenAPI

El documento (`openapi.json`) que describe la API y es **lo único que une** al backend con el frontend. Lo
genera el backend de su propio código y el frontend deriva de él sus tipos.

**Código:** `openapi.json`

**Estado:** Decidido (ADR 0001)

### Puerto

Una interfaz que el dominio declara para lo que necesita de afuera (un reloj, un almacén, una API) o para lo que
ofrece (un caso de uso). Vive en `domain/ports/`.

**Código:** `Port`

**Estado:** Decidido (ADR 0002)

### Adaptador

Lo que implementa un puerto con una tecnología concreta (HTTP, Prisma, `localStorage`). Vive en `adapters/`.

**Código:** `Adapter`

**Estado:** Decidido (ADR 0002)

### Caso de uso

Una cosa que la aplicación hace: «registrar una venta», «vigilar la conexión». Orquesta el dominio a través de
puertos y vive en `application/usecases/`.

**Código:** `UseCase`

**Estado:** Decidido (ADR 0002)

### Ambiente

Dónde corre el sistema: **local**, **DEV** (la rama `desarrollo`, verificada por el CI), **PRE** y **PROD**. PROD
está en pausa. Ver el [plan de ambientes](../ambientes.md).

**Código:** —

**Estado:** Decidido (ADR 0010)

### Ciclo

La unidad de entrega: un objetivo, tickets pequeños y una demostración verificable. Empieza con
`APROBADO CICLO N` y termina con `CERRADO CICLO N`; en medio, la revisión de cada PR por la otra persona.

**Código:** —

**Estado:** Requisito

### Ticket

Un Issue de GitHub con el prefijo de su ciclo en el título (`[C1-07]`): una unidad de trabajo para una persona y
un PR por repositorio. Ver la [guía de GitHub](../guia-github.md).

**Código:** —

**Estado:** Decidido (ADR 0010)

### ADR

Una decisión de arquitectura escrita, con su contexto, las alternativas que se descartaron y lo que se pierde.
No se edita: si cambia, otro ADR lo reemplaza. Ver [el índice](../adr/README.md).

**Código:** —

**Estado:** Decidido (ADR 0010)
