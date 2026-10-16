## Qué hacemos

<!-- Una o dos frases. Qué cambia y por qué. -->

Refs: #

## Evidencia

- [ ] Escribimos las pruebas primero y las vimos fallar por la razón correcta (pegamos la salida en rojo y en verde).
- [ ] `npm run lint`, `format:check`, `typecheck`, `test:coverage` y `build` pasan.
- [ ] Si tocamos la API, regeneramos `openapi.json` con `npm run openapi`.
- [ ] Si tocamos la base de datos, las pruebas de integración pasan (`npm run test:integration`) y no editamos una migración ya aplicada.

## Documentación y decisiones

- [ ] Actualizamos en este mismo PR la documentación que cambia.
- [ ] Si tomamos una decisión de arquitectura, la escribimos como ADR.

## Seguridad

- [ ] No hay secretos, claves ni datos personales en el código, los registros ni este PR.
- [ ] Los commits no llevan `Co-Authored-By` ni marcas de generación.

## Qué conviene mirar al revisar

<!-- Dónde está lo delicado o lo que dudamos. -->

## Fuera de alcance y pendiente

<!-- Qué dejamos para otro ticket, para que nadie lo dé por hecho. -->

> El PR queda en borrador hasta que el CI esté en verde. Quien lo abre no lo aprueba ni lo fusiona.
