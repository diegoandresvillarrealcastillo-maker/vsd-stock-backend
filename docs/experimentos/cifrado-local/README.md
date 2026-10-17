# Experimento: cifrado local en un navegador real

Respalda el [ADR 0018](../../adr/0018-cifrado-local-y-olvido-del-dispositivo.md). Es una página sola
([`index.html`](index.html), sin dependencias) que prueba, en el navegador que la abre, lo que el ADR afirma sobre
cómo se protege lo que VSD Stock guarda en el dispositivo y cómo se olvida. **No es código del producto:** es un
esqueleto desechable que el Ciclo 3 reemplaza por pruebas sobre el motor real.

## Cómo correrlo

Necesita un contexto seguro (`localhost` o HTTPS): sin él, el navegador no ofrece WebCrypto.

```bash
python -m http.server 5199 --bind 127.0.0.1 --directory docs/experimentos/cifrado-local
```

1. Abre <http://127.0.0.1:5199/index.html?fase=1>: crea la clave y guarda datos (7 comprobaciones).
2. Después abre <http://127.0.0.1:5199/index.html?fase=2>: es **otra carga de la página**, así que prueba que todo
   sigue ahí tras recargar, intenta alterar lo guardado y olvida (8 comprobaciones).

La página muestra una tabla y deja el resultado en `window.__resultados`. Cada fila dice qué se comprobó, si pasó y
el detalle.

### Sabotajes: ver que el experimento sí detecta el fallo

`?rompe=...` estropea a propósito el diseño. Cada uno debe hacer fallar justo su comprobación:

| Parámetro     | Qué estropea                          | Comprobaciones que fallan  |
| ------------- | ------------------------------------- | -------------------------- |
| `extraible`   | Crea la clave con `extractable: true` | 1.2 y 2.1                  |
| `enClaro`     | Guarda el registro sin cifrar         | 1.3 (y detiene la corrida) |
| `reutilizaIV` | Usa siempre el mismo IV               | 1.5                        |
| `sinAAD`      | No autentica el nombre del registro   | 2.4                        |
| `sinOlvidar`  | «Olvidar» no borra la base            | 2.6, 2.7 y 2.8             |

Se corre cada uno con `?fase=1&rompe=...` y después `?fase=2&rompe=...`.

## Qué resultó (Chromium 155, Windows, 2026-10-17)

Con el diseño correcto pasan las **15 comprobaciones**:

| #   | Comprobación                                                          | Resultado                                           |
| --- | --------------------------------------------------------------------- | --------------------------------------------------- |
| 1.1 | El contexto es seguro (sin él no existe WebCrypto)                    | Sí en `localhost`                                   |
| 1.2 | La clave no se puede exportar                                         | `exportKey` → `InvalidAccessError`                  |
| 1.3 | Lo guardado no contiene el texto original ni el nombre de un campo    | Sin rastro en 81 bytes                              |
| 1.4 | Con la clave, el registro se descifra                                 | Igual al original                                   |
| 1.5 | 10 000 cifrados del mismo texto dan 10 000 IV y resultados distintos  | 10 000 y 10 000                                     |
| 1.6 | Costo de 1 000 registros de 2 KB                                      | 0,27 ms al escribir y 0,16 ms al leer, por registro |
| 1.7 | _Informativo:_ almacenamiento persistente                             | `persisted()` = `false`; cuota ≈ 10 GB              |
| 2.1 | Tras recargar, la clave sigue y sigue sin poder exportarse            | `type=secret`, `extractable=false`                  |
| 2.2 | Tras recargar, el registro se descifra                                | Igual al original                                   |
| 2.3 | Alterar un solo bit hace fallar el descifrado                         | `OperationError`                                    |
| 2.4 | Copiar un registro cifrado al lugar de otro hace fallar el descifrado | `OperationError`                                    |
| 2.5 | Otra clave no abre lo guardado                                        | `OperationError`                                    |
| 2.6 | Olvidar borra la base                                                 | Estaba en `indexedDB.databases()` y ya no           |
| 2.7 | Tras olvidar no quedan ni la clave ni los registros                   | Ninguno                                             |
| 2.8 | Una copia del texto cifrado no se abre con la clave nueva             | `OperationError`                                    |

Los cinco sabotajes fueron detectados: `extraible` rompe 1.2 y 2.1; `enClaro`, 1.3; `reutilizaIV`, 1.5; `sinAAD`,
2.4; y `sinOlvidar`, 2.6, 2.7 y 2.8.

## Lo que este experimento NO demuestra

- **Solo se corrió en Chromium.** Firefox y Safari (incluido el de iPhone y iPad) quedan sin verificar.
- **No dice cómo guarda cada navegador la clave en el disco.** Que no se pueda _exportar_ con la API no significa
  que sea irrecuperable para quien tenga el perfil completo del navegador; el ADR parte de que no lo es.
- **No prueba nada contra un ataque desde la propia página** (un script malicioso puede usar la clave sin
  exportarla).
- **No es el motor real:** no hay cola de operaciones, ni Web Locks, ni varias pestañas.
- **`persisted()` es `false` aquí.** Lo que haga el navegador del cliente con una PWA instalada y usada a diario no
  se probó.
