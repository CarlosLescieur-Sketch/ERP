import { DomainError } from './errors.js';

export const PAYMENT_METHODS = ['cash', 'transfer', 'card'];
export const PAYMENT_METHOD_LABELS = { cash: 'Efectivo', transfer: 'Transferencia', card: 'Tarjeta' };

/**
 * Valida un pago registrado sobre una orden.
 * El monto debe ser > 0; el exceso contra el saldo se valida en el caso de uso
 * (necesita leer la orden, que es trabajo del puerto, no del dominio).
 */
export function buildPayment({ amount, method = 'cash', note = null }) {
  const a = Number(amount);
  if (!Number.isFinite(a) || a <= 0) throw new DomainError('El monto del pago debe ser mayor a 0');
  if (!PAYMENT_METHODS.includes(method)) throw new DomainError('Método de pago inválido (efectivo, transferencia o tarjeta)');
  return {
    amount: Math.round(a * 100) / 100,
    method,
    note: note?.trim() || null,
  };
}
