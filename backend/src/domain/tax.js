// Cálculo de impuestos. Regla de redondeo: el IVA se calcula y redondea POR
// LÍNEA (no sobre el total) para que la suma de las líneas siempre cuadre con
// el subtotal/tax de la orden, aun con precios con muchos decimales.
import { DomainError } from './errors.js';

// Tasa por defecto (México, 16%). Las líneas guardan su propia tasa para
// soportar exentos o cambios de ley sin tocar el esquema.
export const DEFAULT_TAX_RATE = 16;

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Totales de una línea: precio unitario es NETO (sin impuesto).
 * @param {number} quantity  unidades (entero > 0)
 * @param {number} unitPrice precio neto por unidad
 * @param {number} [rate]    tasa en porcentaje (16 = 16%)
 * @returns {{subtotal:number, tax:number, total:number}}
 */
export function lineTotals(quantity, unitPrice, rate = DEFAULT_TAX_RATE) {
  const subtotal = round2(quantity * unitPrice);
  const tax = round2(subtotal * rate / 100);
  return { subtotal, tax, total: round2(subtotal + tax) };
}

/** Totales de varias líneas: suma de las líneas ya redondeadas. */
export function orderTotals(lines, rate = DEFAULT_TAX_RATE) {
  if (!Array.isArray(lines) || lines.length === 0) throw new DomainError('Agrega al menos un producto');
  let subtotal = 0;
  let tax = 0;
  for (const l of lines) {
    const t = lineTotals(l.quantity, l.unitPrice, l.taxRate ?? rate);
    subtotal = round2(subtotal + t.subtotal);
    tax = round2(tax + t.tax);
  }
  return { subtotal, tax, total: round2(subtotal + tax) };
}
