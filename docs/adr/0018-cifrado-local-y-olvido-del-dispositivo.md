# ADR 0018 — Cifrado de lo guardado en el dispositivo y olvido en un solo paso

- **Estado:** Aceptada
- **Fecha:** 2026-10-17
- **Ciclo:** 1

## Contexto

El [ADR 0009](0009-motor-offline-y-libro-de-movimientos.md) decidió que lo que se hace sin conexión se guarda en el
dispositivo (IndexedDB) y dejó para el Ciclo 1 «el cifrado local (AES-GCM, clave no extraíble y qué amenaza cubre
y cuál no) y cuándo se olvida lo guardado». Lo que se guarda son ventas, existencias, precios y, a veces, datos de
clientes: **datos del negocio y datos personales** (Ley 1581 de Colombia), en un equipo que puede ser compartido
entre varias personas y que puede perderse o prestarse.

Este ADR decide qué se cifra, con qué, qué amenaza cubre **y cuál no**, y cuándo se olvida. Se comprobó en un
navegador real con el [experimento de cifrado local](../experimentos/cifrado-local/README.md): 15 comprobaciones
en Chromium 155, y cinco sabotajes a propósito que el experimento detecta.

## Decisión

1. **Se cifra el contenido de cada registro** que se guarda en IndexedDB con **AES-GCM de 256 bits**, un **IV
   aleatorio de 96 bits por registro** y **el nombre del registro como dato autenticado adicional (AAD)**. Cifrar
   10 000 veces el mismo texto dio 10 000 IV y 10 000 resultados distintos. El AAD hace que un registro copiado al
   lugar de otro **no se abra**, y GCM hace que **alterar un solo bit** tampoco: el descifrado falla, no devuelve
   datos corruptos.
2. **Los nombres y los índices de IndexedDB no se cifran** (un índice cifrado no sirve para buscar). Por eso los
   campos que se usan como clave o índice (códigos, folios, identificadores, fechas) **nunca llevan datos
   personales**: el nombre de un cliente va dentro del contenido cifrado, jamás en la clave del registro.
3. **La clave es una `CryptoKey` AES-GCM con `extractable: false`,** generada en el dispositivo la primera vez que
   la persona entra y guardada en **su propia base**. No se puede exportar (`exportKey` falla con
   `InvalidAccessError`), sobrevive a recargar la página y se borra con la base.
4. **No hay una contraseña ni un PIN que envuelva la clave.** El mostrador no se bloquea por un PIN olvidado.
5. **Una base por persona y por dispositivo,** con el identificador (UUID) de la persona como nombre, nunca su
   nombre ni su correo: los nombres de las bases son visibles (`indexedDB.databases()`).
6. **Nada secreto se guarda en la base:** las contraseñas, nunca; los tokens de acceso, solo en memoria. Así lo que
   protege el cifrado son datos de negocio, no credenciales.
7. **Olvidar es un solo paso:** borrar la base de esa persona (`deleteDatabase`), que se lleva la clave. Se
   comprobó que después ya no aparece entre las bases del origen, que no queda ni la clave ni un registro, y que
   una copia del texto cifrado que alguien se hubiera llevado **no se abre con la clave nueva**. Olvidar un
   dispositivo borra también su serie de folios: para volver a trabajar se registra de nuevo y recibe un código
   nuevo (ADR 0016).
8. **Cuándo se olvida:**
   - **Al cerrar sesión de forma explícita.** Si hay operaciones sin enviar, antes se avisa **cuántas son** y se
     pide confirmación: si la persona confirma, se pierden; si no, se sincroniza primero.
   - **Cuando se da de baja a la persona o al dispositivo.** El dispositivo se entera al conectarse: **sincroniza
     lo pendiente y después olvida.**
   - **Cuando la sesión caduca, NO.** La interfaz se bloquea y la base cifrada se conserva, para no perder ventas.
9. **Hay requisitos de plataforma:**
   - **La aplicación se sirve siempre por HTTPS.** Sin contexto seguro no existe WebCrypto (comprobado: 1.1), y
     tampoco los _service workers_.
   - **Se pide almacenamiento persistente** (`navigator.storage.persist()`) al iniciar sesión y se avisa si no se
     concede: el navegador puede borrar el almacenamiento no persistente cuando falta espacio (`persisted()` dio
     `false` en la prueba).
10. **Costo:** 0,27 ms por registro al cifrar y guardar y 0,16 ms al leer y descifrar (registros de 2 KB). No pesa
    en el punto de venta.

### Qué cubre y qué no

| Amenaza                                                                                  | ¿La cubre?                                |
| ---------------------------------------------------------------------------------------- | ----------------------------------------- |
| Alguien lee los archivos de la base con una herramienta que no ejecuta la aplicación     | Sí                                        |
| Alguien abre las herramientas del navegador y mira lo guardado                           | Sí                                        |
| Alguien altera o intercambia registros en el disco                                       | Sí (se detecta)                           |
| Un equipo que se presta o se pierde, con la sesión cerrada y la base olvidada            | Sí                                        |
| Un script malicioso dentro de la página (XSS)                                            | **No:** usa la clave sin exportarla       |
| Alguien con la sesión abierta, o con acceso a la cuenta del sistema operativo del equipo | **No**                                    |
| Alguien que copia el perfil **completo** del navegador y lo abre con un navegador        | **No:** la clave viaja con él (ver abajo) |
| Malware con acceso al proceso del navegador                                              | **No**                                    |
| El servidor, o lo que viaja por la red (eso lo cubre HTTPS)                              | No es de este ADR                         |

**Lo que no se verificó:** cómo guarda cada navegador la clave no exportable en el disco. Que la API no permita
exportarla **no prueba** que sea irrecuperable para quien tenga el perfil entero. Este ADR parte de que no lo es y
por eso **no promete protección contra un atacante con acceso al perfil**.

## Alternativas consideradas

### No cifrar, y confiar en cerrar sesión y borrar

Es lo más simple y deja los datos personales en claro en el disco mientras la base exista, que es justo en un
equipo compartido o perdido con operaciones sin enviar. El cifrado cuesta fracciones de milisegundo.

### Envolver la clave con un PIN o una contraseña (PBKDF2)

Es la única forma de proteger de verdad contra la copia del perfil, porque la clave no queda en el disco en claro.
Pero obliga a pedir el PIN cada vez que se abre la aplicación, a dejar sin acceso a quien lo olvide, y a perder
ventas pendientes si el PIN se pierde. **Se descarta por costo de uso** y queda como la mejora a pedir si un
negocio necesita protegerse del perfil copiado.

### Una clave que viene del servidor y vive solo en memoria

Protege al perfil copiado (la clave no está en el disco), pero **sin conexión, tras cerrar el navegador, no hay
clave**: el negocio no podría abrir su propia caja en un corte de internet. Contradice el principio de que se pueda
seguir vendiendo.

### Una base cifrada completa (SQLite cifrado en WebAssembly)

Cifra también los índices, a cambio de bastante más peso, otra dependencia y una arquitectura distinta a la de
`idb`. Con la regla de que los índices no llevan datos personales alcanza.

### Una clave extraíble

No aporta nada: quien puede ejecutar código en la página puede exportarla y llevársela.

### Conservar la base al cerrar sesión de forma explícita

Dejaría datos en un equipo cuya persona dijo que se iba. Cerrar sesión es olvidar.

## Consecuencias

### A favor

- Los datos del negocio y los personales no son legibles en el disco ni en las herramientas del navegador.
- Alterar o mezclar lo guardado se detecta en vez de producir datos corruptos.
- Olvidar es total y de un solo paso, y una copia previa del cifrado queda inservible.
- El costo es despreciable y no cambia cómo se escribe el motor sin conexión.

### En contra

- **La protección es limitada, y la tabla de arriba lo dice:** no cubre un ataque desde la página, ni el perfil
  copiado, ni el equipo de alguien que lo controla. Nadie debe venderlo como más de lo que es.
- **La clave vive junto a los datos.** Es la consecuencia de no pedir un PIN, y se decidió así a conciencia.
- **Perder la clave pierde los datos.** Si el navegador borra la clave y deja los datos (o al revés), lo guardado
  es irrecuperable; si eso incluye operaciones sin enviar, son ventas perdidas. Por eso se muestra siempre cuántas
  hay pendientes y se pide sincronizar pronto.
- **Cerrar sesión con pendientes las pierde si la persona lo confirma.**
- **Nada de esto está verificado fuera de Chromium.** Firefox y Safari, y en especial el Safari de iPhone y iPad
  (que, según se reporta, limita el almacenamiento de las aplicaciones web que no se usan en varios días) **deben
  comprobarse antes de prometer el modo sin conexión en esos equipos.**
- **No se pueden buscar los campos cifrados** desde IndexedDB: lo que haya que buscar tiene que estar en un índice
  en claro, es decir, sin datos personales.
- **Un token solo en memoria complica la sesión sin conexión** (Ciclo 2): al recargar la página hay que volver a
  obtenerlo, y sin red eso no se puede.
- **Cada navegador decide cuándo borrar el almacenamiento no persistente,** y la aplicación solo puede pedirlo.

### Mitigación acordada

- El experimento es reproducible (`docs/experimentos/cifrado-local`) y sus sabotajes prueban que detecta lo que
  dice detectar.
- El Ciclo 3 repite estas comprobaciones sobre el motor real, y al menos en un teléfono real, antes de la entrega.
- Antes de pedir la persistencia se prueba qué hace de verdad el navegador de los equipos del negocio de
  referencia.
