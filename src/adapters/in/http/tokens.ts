/**
 * Identificadores de inyeccion de los puertos de entrada que usan los
 * controladores. Viven en el adaptador y no en infrastructure/ porque el
 * adaptador no puede importar de infrastructure/ (ADR 0002): es
 * infrastructure/ quien importa este token para decidir que se inyecta.
 */
export const GET_HEALTH = Symbol('GET_HEALTH');
export const GET_READINESS = Symbol('GET_READINESS');
