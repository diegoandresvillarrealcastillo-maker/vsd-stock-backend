/**
 * Puerto de salida: el reloj.
 * El dominio y la aplicacion nunca llaman a Date.now() por su cuenta: piden
 * la hora por aqui, y asi las pruebas la controlan.
 */
export interface Clock {
  now(): Date;
}
