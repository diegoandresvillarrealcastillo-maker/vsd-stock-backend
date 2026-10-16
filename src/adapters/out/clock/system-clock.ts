import type { Clock } from '../../../domain/ports/out/clock.js';

/** Adaptador de salida: el reloj de la maquina. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
