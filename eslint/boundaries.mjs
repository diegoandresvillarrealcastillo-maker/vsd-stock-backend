/**
 * Fronteras de la arquitectura hexagonal (ADR 0002).
 *
 * Regla de dependencia, siempre hacia adentro:
 *
 *   infrastructure, adapters  ->  application  ->  domain
 *
 * Sin esta comprobacion la arquitectura se erosiona sin que nadie lo note:
 * alguien importa Prisma en el dominio "solo esta vez" y meses despues el
 * nucleo ya no se puede probar sin una base de datos. Un acuerdo escrito no
 * basta; esto rompe el build.
 *
 * Los patrones se escriben sobre el texto del import (la ruta relativa), no
 * sobre el grafo real de dependencias. Por eso el proyecto usa rutas
 * relativas: si algun dia se introduce un alias, estas reglas y su prueba
 * (test/architecture/boundaries.spec.ts) se actualizan en el mismo PR.
 *
 * Cada mensaje dice que hacer, no solo que esta prohibido.
 */

const DOMINIO_A_CAPAS =
  'domain/ no puede depender de application/, adapters/ ni infrastructure/: las dependencias apuntan hacia adentro. Si el dominio necesita algo de afuera, lo que falta es un puerto en domain/ports/out/ que un adaptador implemente.';

const DOMINIO_EXTERNO =
  'domain/ no puede importar paquetes externos ni modulos de Node: el nucleo debe poder probarse sin framework. Si necesitas algo del exterior (hora, identificadores, base de datos), declara un puerto en domain/ports/out/ y ponle un adaptador en adapters/out/.';

const APLICACION_A_EXTERIOR =
  'application/ no puede depender de adapters/ ni de infrastructure/, ni siquiera en sus pruebas. Depende del puerto que declara domain/, y es infrastructure/config quien decide que adaptador se inyecta.';

const ADAPTADOR_A_INFRA =
  'adapters/ no puede depender de infrastructure/: es infrastructure/ quien importa los adaptadores para cablearlos. Si necesitas un identificador de inyeccion, definelo junto al adaptador (ver adapters/in/http/tokens.ts).';

const ENTRADA_A_SALIDA =
  'adapters/in no puede importar de adapters/out. Un adaptador de entrada habla con application/ a traves de los puertos de domain/ports/in/, no con otro adaptador.';

const SALIDA_A_ENTRADA =
  'adapters/out no puede importar de adapters/in. Un adaptador de salida solo implementa un puerto de domain/ports/out/; no conoce a quien lo llama.';

const DINAMICO =
  'En domain/ y application/ no se usan require ni import() dinamico: esconden dependencias que no-restricted-imports no ve. Usa un import estatico y, si hace falta algo de afuera, un puerto en domain/ports/out/.';

/** @type {import('eslint').Linter.Config[]} */
export const boundaries = [
  // ---------- El dominio no depende de nadie ----------
  {
    files: ['src/domain/**/*.ts'],
    // Las pruebas necesitan importar el ejecutor de pruebas y no forman parte
    // de lo que se despliega: se les prohiben las capas, no los paquetes.
    ignores: ['src/domain/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/application/**', '**/adapters/**', '**/infrastructure/**'],
              message: DOMINIO_A_CAPAS,
            },
            {
              // Todo lo que no empiece por "." es un paquete externo o un
              // modulo de Node. El dominio no puede usar ninguno.
              regex: '^[^.]',
              message: DOMINIO_EXTERNO,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/domain/**/*.spec.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/application/**', '**/adapters/**', '**/infrastructure/**'],
              message: DOMINIO_A_CAPAS,
            },
          ],
        },
      ],
    },
  },

  // ---------- La aplicacion no conoce adapters ni infrastructure ----------
  {
    files: ['src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/adapters/**', '**/infrastructure/**'],
              message: APLICACION_A_EXTERIOR,
            },
          ],
        },
      ],
    },
  },

  // ---------- Los adaptadores no conocen infrastructure ni se conocen entre si ----------
  {
    files: ['src/adapters/in/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/infrastructure/**'], message: ADAPTADOR_A_INFRA },
            {
              // Desde adapters/in, llegar a adapters/out es subir con "../" y
              // entrar en "out/". Un "../domain/ports/out/..." no coincide
              // porque tras los "../" viene "domain/".
              regex: '^(\\.\\./)+out/',
              message: ENTRADA_A_SALIDA,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/adapters/out/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['**/infrastructure/**'], message: ADAPTADOR_A_INFRA },
            { regex: '^(\\.\\./)+in/', message: SALIDA_A_ENTRADA },
          ],
        },
      ],
    },
  },

  // ---------- Sin require ni import() dinamico en el nucleo ----------
  {
    files: ['src/domain/**/*.ts', 'src/application/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: 'ImportExpression', message: DINAMICO },
        { selector: "CallExpression[callee.name='require']", message: DINAMICO },
      ],
    },
  },
];
