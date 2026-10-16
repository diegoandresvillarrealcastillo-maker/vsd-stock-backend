/**
 * Configuracion de commitlint para VSD Stock.
 *
 * Aplica Conventional Commits y, ademas, exige que cada commit cite su Issue
 * de GitHub. Esa referencia es la que da trazabilidad entre ticket, rama,
 * commit y Pull Request (ver docs/adr/0010-flujo-de-trabajo-en-github.md).
 *
 * Ejemplo valido:
 *   feat(health): sumamos GET /health con el esqueleto hexagonal
 *
 *   Refs: #4
 */
export default {
  extends: ['@commitlint/config-conventional'],

  parserPreset: {
    parserOpts: {
      // Permite que commitlint reconozca "#4" como una referencia.
      issuePrefixes: ['#'],
    },
  },

  rules: {
    'type-enum': [
      2,
      'always',
      [
        'feat', // nueva funcionalidad
        'fix', // correccion de un defecto
        'docs', // solo documentacion
        'style', // formato, sin cambio de comportamiento
        'refactor', // reestructuracion sin cambio de comportamiento
        'perf', // mejora de rendimiento
        'test', // pruebas
        'build', // dependencias o sistema de construccion
        'ci', // integracion continua
        'chore', // tareas de mantenimiento
        'revert', // reversion de un commit anterior
      ],
    ],

    // Todo commit debe citar al menos un Issue (#N).
    'references-empty': [2, 'never'],

    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [2, 'always', 100],

    // El asunto se redacta en espanol, en minuscula y sin punto final.
    'subject-case': [0],
    'subject-full-stop': [2, 'never', '.'],
  },
};
