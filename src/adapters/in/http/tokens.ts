/**
 * Identificadores de inyeccion de los puertos de entrada que usan los
 * controladores. Viven en el adaptador y no en infrastructure/ porque el
 * adaptador no puede importar de infrastructure/ (ADR 0002): es
 * infrastructure/ quien importa este token para decidir que se inyecta.
 */
export const GET_HEALTH = Symbol('GET_HEALTH');
export const GET_READINESS = Symbol('GET_READINESS');
export const AUTHENTICATE = Symbol('AUTHENTICATE');
export const GET_ME = Symbol('GET_ME');
export const CREATE_BUSINESS = Symbol('CREATE_BUSINESS');
export const INVITE_USER = Symbol('INVITE_USER');
export const REDEEM_INVITATION = Symbol('REDEEM_INVITATION');
export const LIST_USERS = Symbol('LIST_USERS');
export const UPDATE_USER = Symbol('UPDATE_USER');
export const REGENERATE_INVITATION = Symbol('REGENERATE_INVITATION');
export const CATEGORIES = Symbol('CATEGORIES');
export const PRODUCTS = Symbol('PRODUCTS');
export const SUPPLIERS = Symbol('SUPPLIERS');
export const PURCHASES = Symbol('PURCHASES');
export const WAREHOUSE = Symbol('WAREHOUSE');
export const STOCK = Symbol('STOCK');
export const STOCK_ADJUSTMENTS = Symbol('STOCK_ADJUSTMENTS');
export const DEVICES = Symbol('DEVICES');
export const SHIFTS = Symbol('SHIFTS');
export const CASH_MOVEMENTS = Symbol('CASH_MOVEMENTS');
export const SALES = Symbol('SALES');
