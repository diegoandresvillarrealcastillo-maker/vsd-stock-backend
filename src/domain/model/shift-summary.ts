/** Lo que la base suma de un turno, sin interpretarlo: las ventas en efectivo, el efectivo que entro y salio, y las ventas tardias. */
export interface ShiftCashTotals {
  /** Pesos cobrados en efectivo en las ventas del turno que llegaron a tiempo. */
  readonly cashSales: number;
  /** Pesos que entraron a la caja fuera de una venta. */
  readonly cashIn: number;
  /** Pesos que salieron de la caja fuera de una venta (un pago, una devolucion por una venta anulada). */
  readonly cashOut: number;
  /** Las ventas que ocurrieron DESPUES de cerrarse el turno y llegaron a el (ADR 0026): se muestran aparte. */
  readonly late: { readonly count: number; readonly cashAmount: number };
}

/** El arqueo de un turno (ADR 0026): lo que debia haber en la caja frente a lo que la persona conto. */
export interface ShiftCashSummary {
  readonly openingAmount: number;
  readonly cashSales: number;
  readonly cashIn: number;
  readonly cashOut: number;
  /** El efectivo que debia haber: lo inicial, mas lo cobrado, mas lo que entro, menos lo que salio. */
  readonly expectedAmount: number;
  /** Lo que la persona conto al cerrar; `null` mientras el turno sigue abierto. */
  readonly countedAmount: number | null;
  /** Contado menos esperado: negativo es que falta, positivo que sobra; `null` mientras el turno sigue abierto. */
  readonly difference: number | null;
  readonly lateSales: { readonly count: number; readonly cashAmount: number };
}

/**
 * Hace el arqueo. Las ventas tardias NO entran en lo esperado: la persona conto la caja antes de que llegaran, y mezclarlas
 * escondería la diferencia que de verdad hubo en ese momento. Se muestran aparte para que quien revisa las sume si el
 * efectivo ya estaba en la caja.
 */
export function summarizeShift(
  shift: { readonly openingAmount: number; readonly countedAmount: number | null },
  totals: ShiftCashTotals,
): ShiftCashSummary {
  const expectedAmount = shift.openingAmount + totals.cashSales + totals.cashIn - totals.cashOut;
  return {
    openingAmount: shift.openingAmount,
    cashSales: totals.cashSales,
    cashIn: totals.cashIn,
    cashOut: totals.cashOut,
    expectedAmount,
    countedAmount: shift.countedAmount,
    difference: shift.countedAmount === null ? null : shift.countedAmount - expectedAmount,
    lateSales: totals.late,
  };
}
