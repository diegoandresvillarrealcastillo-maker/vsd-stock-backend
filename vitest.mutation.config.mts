import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

// La configuracion de las pruebas que Stryker repite una vez por cada rotura (npm run mutation, C3-17). Es la del proyecto con tres
// cambios:
//  - solo las pruebas de las capas que rompe (dominio y aplicacion) y la de los vectores de calculo del contrato, que ejecuta el
//    dominio: las demas (de integracion, de arquitectura, de documentos) no vigilan esas capas y tardan en cada vuelta. Las del
//    contrato que comparan archivos generados no corren bien en la copia donde Stryker rompe el codigo;
//  - un plazo por prueba que alcance para correr rota e instrumentada: con los 5 s de siempre, una prueba pesada se agota en la
//    ejecucion inicial y Stryker se niega a empezar;
//  - sin cobertura: la de `npm run test:coverage` es la que cuenta, aqui solo se repiten pruebas.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/domain/**/*.spec.ts',
      'src/application/**/*.spec.ts',
      'test/contract/calculation-vectors.spec.ts',
    ],
    testTimeout: 30_000,
    coverage: { enabled: false },
  },
});
