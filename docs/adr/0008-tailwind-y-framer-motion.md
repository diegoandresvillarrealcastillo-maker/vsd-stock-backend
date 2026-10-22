# ADR 0008 — Estilo con Tailwind y movimiento con Framer Motion

- **Estado:** Aceptada
- **Fecha:** 2026-10-16
- **Ciclo:** 0

## Contexto

VSD Stock busca una interfaz cuidada y con movimiento con intención. En VSD Health usamos CSS plano con
variables (`--app-*`). **El dueño del proyecto decidió cambiar a propósito** para VSD Stock: el estilo se
hace con Tailwind CSS y el movimiento con Framer Motion. Este ADR registra esa decisión y las reglas que la
acompañan.

## Decisión

- **Tailwind CSS 4** con `@tailwindcss/vite`. Los tokens de diseño (color, tipografía, espacio, radio, sombra,
  duración y curva de movimiento) se definen **una sola vez** como variables CSS en `@theme` y se usan desde
  Tailwind. Modo claro y oscuro desde el inicio. Estética corporativa limpia de VSD: fondos limpios y acento
  verde.
- **`framer-motion`** para el movimiento: variantes y transiciones compartidas en `presentation/motion/`,
  `AnimatePresence` para entradas y salidas, `layout` para reordenar listas y `whileTap` para gestos.
- **Solo `transform` y `opacity`**, salvo justificación escrita en el PR. Las animaciones `layout` son una
  excepción conocida: Framer las implementa con transformaciones, pero pueden distorsionar a los hijos.
- **`useReducedMotion` es obligatorio en toda animación.** Con movimiento reducido, se sustituye por un
  fundido simple o por nada.
- **Skeletons animados** que reproducen el diseño real de cada pantalla, no spinners genéricos.
- **Presupuesto de rendimiento del punto de venta:** respuesta visible al tocar en menos de 100 ms y 60 fps
  en un teléfono de gama baja. Una animación bonita que frena el cobro se quita.
- **Accesibilidad:** WCAG AA, objetivos táctiles de al menos 44 px, teclado completo en el punto de venta y
  Lighthouse de accesibilidad en el CI.

## Alternativas consideradas

### CSS plano con variables (como en Health)

Es lo que el equipo ya domina y evita una dependencia. Se descartó por decisión del dueño del proyecto.

### CSS Modules o una biblioteca de componentes

Una biblioteca de componentes acelera, pero impone su estética y pesa. Los módulos CSS no resuelven el
sistema de diseño compartido.

### Solo animaciones CSS o `react-spring`

Las animaciones CSS no cubren bien las salidas ni el reordenamiento de listas. No vemos ventaja en cambiar
de biblioteca.

## Consecuencias

### A favor

- Un sistema de tokens único y utilidades rápidas para construir pantallas consistentes.
- Entradas, salidas y reordenamientos animados sin código manual.

### En contra

- Las cadenas largas de clases ensucian el código y se repiten.
- El equipo conoce menos Tailwind que CSS plano, y el plazo es corto.
- **Framer Motion pesa en el paquete** y eso importa en un teléfono de gama baja.
- La regla de `transform` y `opacity` limita lo que se puede animar.

### Mitigación acordada

- Extraemos componentes en lugar de repetir cadenas de clases.
- En C0-07 medimos la línea base (Lighthouse y un dispositivo real) y probamos `LazyMotion` con los
  componentes `m` para reducir peso. Es una **hipótesis, no un dato medido**: el resultado se registra.
- Toda excepción a `transform` y `opacity` se justifica en el PR.
