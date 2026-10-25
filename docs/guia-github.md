# Guía de GitHub

Cómo se usa GitHub en VSD Stock: tickets, hitos, etiquetas, plantillas y protección de ramas. El porqué de
cada regla está en el [ADR 0010](adr/0010-flujo-de-trabajo-en-github.md); esta guía es el cómo. **No usamos
Jira:** los tickets viven en los Issues de cada repositorio.

## Un cambio, de principio a fin

1. **Crea el Issue** en el repositorio que corresponda, **antes** de empezar: título `[Cn-NN] …`, una persona
   asignada, el hito del ciclo y sus etiquetas.
2. **Crea una rama corta** desde `desarrollo` actualizado: `feat/c1-07-descripcion-corta`.
3. **Trabaja con la prueba primero** y commits `Refs: #N` (ver [CONTRIBUTING](../CONTRIBUTING.md)).
4. **Abre el PR en borrador contra `desarrollo`**, con la plantilla. Se queda en borrador hasta que el CI esté
   en verde.
5. **Márcalo listo y pide la revisión** a la otra persona. «Listo» es CI en verde y estado `CLEAN` (sin
   conflictos); que el estado diga `BLOCKED` solo porque falta la aprobación es lo esperado.
6. **La otra persona revisa y fusiona** con «Create a merge commit». Quien abrió el PR no lo aprueba ni lo
   fusiona. Si pide cambios, se corrigen en el mismo PR.
7. **Verifica que llegó:** «fusionado» es que el commit está en `desarrollo` (`git fetch` y
   `git branch -r --contains <commit>`), no que el botón dijera «Merged».
8. **Cierra el Issue** con un comentario de lo que se entregó y limpia tu copia: `git fetch --prune` y borra la
   rama local. La rama remota se borra sola al fusionar.

El backend se fusiona **antes** que el frontend que depende de él.

## Cuando un cambio depende de otro: PR apilados

Si un cambio no se puede probar sin otro que aún no está fusionado (en el Ciclo 1, los ADR 0013 a 0020), su rama
sale de la rama del primero y su PR tiene **como base esa rama**, no `desarrollo`. Se llaman apilados. Reglas:

1. **El cuerpo del PR lo dice en la primera línea:** «apilado sobre #N» y que se fusiona después de él.
2. **Se fusionan de uno en uno y en orden, de abajo hacia arriba.** Al fusionar el primero, GitHub borra su rama y
   reorienta el siguiente PR hacia `desarrollo`. **Antes de fusionar el siguiente, comprueba que su base ya dice
   `desarrollo`.** Si se fusiona un instante antes, su contenido entra en la rama vieja y no en `desarrollo`: pasó
   con el PR #26 del backend, cuyo contenido llegó a `desarrollo` por el PR siguiente y dejó una rama remota con un
   commit de fusión que `desarrollo` no tiene.
3. **Un PR que contiene los commits de otro, en el mismo repositorio:** cuando el hermano se fusiona, la base que
   GitHub guarda para el PR puede quedarse en el commit anterior. Lo reconoces porque «Files changed» sigue
   mostrando los archivos del hermano ya fusionado y porque cada aprobación se descarta sola con el mensaje «The
   merge-base changed after approval». **Se arregla cerrando y reabriendo el PR:** GitHub vuelve a calcular la base
   (la lista de archivos baja a los propios del PR) y basta una aprobación nueva. No hace falta tocar ningún commit.
4. **El trabajo «Contrato con el backend» del frontend compara contra la rama base del PR:** mientras el backend del
   que depende no esté en `desarrollo`, sale en rojo, y es lo que debe pasar. Al fusionar el backend, vuelve a
   ejecutarlo.
5. Tras la última fusión, `git fetch --prune`, borra las ramas locales y comprueba que no queda ninguna rama remota
   de la pila: lo que ya está en `desarrollo` no necesita rama.

## Issues

El título lleva el prefijo del ciclo y un número que sigue la secuencia del ciclo: `[C0-04]`, `[C1-07]`. Los
números de Issue de GitHub son **por repositorio** y los PR comparten la misma numeración, así que lo que une un
ticket del backend con el de su frontend es el prefijo `[Cn-NN]`, no el número.

El cuerpo sigue siempre el mismo esqueleto:

```markdown
**Objetivo:** una frase.

**Criterios de aceptación**

- Lo que tiene que ser verdad para dar el ticket por terminado, uno por línea.

**Depende de:** el ticket del que depende, o «nada».

**Definición de terminado**

- Pruebas escritas antes y vistas fallar por la razón correcta.
- CI en verde y PR en estado `CLEAN`.
- Cobertura de `domain/` y `application/` de al menos 80 % (cuando aplique).
- Documentación actualizada en el mismo PR.
- Revisado y fusionado por la otra persona (quien abre el PR no lo aprueba).
```

Un ticket es **pequeño**: cabe en un PR que se revisa en una sola sentada. Si no cabe, se parte. Y un ticket que
aparece a mitad de un ciclo (como lo fue el CORS del backend, C0-11) se abre, se dice por qué estaba fuera del
plan y se numera con el siguiente del ciclo.

## Hitos

Un hito por ciclo, con el nombre **`Ciclo N — nombre`** (hoy, _Ciclo 0 — Fundaciones_), una descripción de una
línea y la fecha en que termina. Se crea cuando se aprueba el ciclo (`APROBADO CICLO N`) y se cierra cuando se
cierra (`CERRADO CICLO N`). Todo Issue y todo PR del ciclo va en su hito.

## Etiquetas

Una de **tipo** y una de **ciclo** por ticket. El tipo es el mismo de las ramas y de los commits.

| Etiqueta  | Para qué                             |
| --------- | ------------------------------------ |
| `feat`    | Funcionalidad nueva                  |
| `fix`     | Corrección de un defecto             |
| `chore`   | Mantenimiento y herramientas         |
| `ci`      | Integración continua                 |
| `docs`    | Documentación                        |
| `test`    | Pruebas                              |
| `adr`     | Decisión de arquitectura             |
| `ciclo-N` | A qué ciclo pertenece (`ciclo-0`, …) |

Cuando empieza un ciclo se crea su etiqueta `ciclo-N` en los dos repositorios. GitHub trae además sus etiquetas
por defecto (`bug`, `documentation`, `enhancement`…); no las usamos para no tener dos formas de decir lo mismo.

## Plantillas

- **PR:** [`.github/pull_request_template.md`](../.github/pull_request_template.md) en cada repositorio. Pide
  lo que hace falta para revisar: qué se hizo, la evidencia (el rojo y el verde de las pruebas), la
  documentación, la seguridad, qué mirar y qué quedó fuera.
- **Ticket:** [`.github/ISSUE_TEMPLATE/ticket.md`](../.github/ISSUE_TEMPLATE/ticket.md) trae el esqueleto de
  arriba.

> **Según la documentación de GitHub, las plantillas se leen de la rama por defecto del repositorio**, que aquí
> es `produccion`, y los PR se abren contra `desarrollo`. Mientras las plantillas no se promuevan, es probable
> que GitHub no las precargue y haya que copiarlas a mano desde el archivo. Es un efecto de que PROD esté en
> pausa, no un error.

## Conjunto de reglas y checks exigidos

Las tres ramas fijas (`desarrollo`, `preproduccion` y `produccion`) las protege el conjunto de reglas
**«Ramas de ambiente»**, activo en los dos repositorios: Pull Request obligatorio, **una aprobación**, descartar
aprobaciones al empujar cambios nuevos, resolver las conversaciones antes de fusionar, sin `force push`, sin
borrado y **sin excepciones para nadie**, administradores incluidos.

Además exige que ciertos **checks del CI** pasen. Estos son los **nombres exactos**; un check es su nombre:

| Check                                          | Backend | Frontend |
| ---------------------------------------------- | ------- | -------- |
| `Escaneo de secretos`                          | Exigido | Exigido  |
| `Convencion de commits`                        | Exigido | Exigido  |
| `Calidad del codigo`                           | Exigido | Exigido  |
| `Pruebas contra PostgreSQL`                    | Exigido | —        |
| `Imagen de Docker`                             | Exigido | —        |
| `Vulnerabilidades en las dependencias`         | Exigido | Exigido  |
| `Analisis de codigo (JavaScript y TypeScript)` | Exigido | Exigido  |
| `Contrato con el backend`                      | —       | Exigido  |
| `Accesibilidad y rendimiento (Lighthouse)`     | —       | Exigido  |

**Paso manual de quien administra el repositorio** (el asistente no lo hace), para exigir un check nuevo:

1. En el repositorio: **Settings → Rules → Rulesets → «Ramas de ambiente»**.
2. En **Require status checks to pass**, pulsa **Add checks**, busca el check por su nombre y agrégalo. Solo
   aparece en la lista si **ya corrió** en el repositorio (por ejemplo, en el PR que lo introdujo).
3. Guarda y comprueba en un PR que el check aparece como requerido.

Dos cosas que conviene saber:

- **Cambiar el nombre de un trabajo del CI es quitar el check exigido:** el PR queda esperando para siempre un
  check que ya no existe. Si el nombre cambia, se cambia a la vez en el conjunto de reglas. Por eso los nombres
  de los trabajos coinciden entre los dos repositorios.
- Un trabajo **saltado** cuenta como aprobado. `Convencion de commits` se salta en las promociones
  (`desarrollo → preproduccion → produccion`) a propósito: sus commits ya se revisaron.

## Cuando «Vulnerabilidades en las dependencias» se pone en rojo

Un aviso nuevo se publica cualquier día y pone en rojo todos los PR hasta que se resuelve (el trabajo corre también cada lunes y en cada
empujón a las ramas de ambiente). Se resuelve en este orden:

1. `npm audit fix` sube lo que se pueda dentro de su rango, sin cambios de versión mayor.
2. Si una dependencia de otra queda **fijada** a una versión con el aviso, se fuerza la versión arreglada con `overrides` en `package.json` y
   se anota abajo **cuándo se quita**. Un `overrides` que nadie recuerda esconde una dependencia vieja el día que el paquete de origen ya
   trae el arreglo.
3. Un aviso sin arreglo solo se acepta con una lista escrita, con su motivo y su fecha. Hoy no hay ninguna.

| `overrides` en `package.json`                | Por qué                                                                                                                                 | Se quita cuando                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `multer` `^2.5.0`                            | `@nestjs/platform-express` fija `multer@2.4.0`, con el aviso GHSA-q7qp-rjg7-q26m (denegación de servicio con un `fileFilter` pendiente) | `@nestjs/platform-express` fije `multer` 2.5.0 o posterior       |
| `qs` `^6.16.1` dentro de `typed-rest-client` | Stryker trae `typed-rest-client`, que arrastra un `qs` con avisos de seguridad                                                          | Stryker o `typed-rest-client` suban su `qs` a 6.16.1 o posterior |

## Con la línea de comandos

`gh` evita abrir el navegador. Tres trampas de Windows y PowerShell 5.1:

- **El texto que pasas por una tubería lleva un carácter invisible (BOM) al principio**, y commitlint lo rechaza.
  Escribe el mensaje de commit en un archivo y usa `git commit -F archivo`.
- **Las comillas complejas se rompen** al pasarlas a `gh`. Para el cuerpo de un Issue o de un PR, arma el JSON en
  un script y envíalo con `gh api --input -`.
- **Un Issue o un PR se asigna, se etiqueta y se le pone hito en otra llamada:** `gh api` sobre
  `repos/<dueño>/<repo>/issues/<número>` con `labels`, `assignees` y `milestone`.

```bash
gh pr create --base desarrollo --draft --title "[C1-07] …" --body-file cuerpo.md
gh pr ready <número>                         # cuando el CI está en verde
gh pr view <número> --json state,mergeStateStatus,reviewDecision
```

## Si eres quien revisa

Una aprobación vale cuando miraste, no cuando el CI está en verde. Lo que se mira:

- **El CI en verde y el estado `CLEAN`.** Si no, no se revisa todavía.
- **La evidencia:** el rojo y el verde de las pruebas, y que las pruebas fallaron por la razón correcta.
- **Que los cambios de la API sean del backend** (y vengan antes que el frontend que los usa).
- **La documentación:** si el código cambió y el documento no, se pide el cambio.
- **Los commits:** español, plural, `Refs: #N`, sin `Co-Authored-By` ni «generado con…».
- **Lo que el PR dice que conviene mirar**, que es donde su autor duda.
- **Qué quedó fuera:** que no se haya dado por hecho algo que quedó pendiente.

Si algo no cuadra, se escribe como conversación del PR y se resuelve en el mismo PR. Al aprobar, se fusiona con
**«Create a merge commit»**.
