import { DomainError } from './errors.js';
import { orderTotals, DEFAULT_TAX_RATE } from './tax.js';

export const ORDER_KINDS = ['purchase', 'sale'];
// Una venta la hace un cliente; una compra se le hace a un proveedor.
export const PARTNER_FOR = { sale: 'customer', purchase: 'supplier' };

/**
 * Valida una orden y calcula sus totales con IVA.
 * `items[].unitPrice` es precio NETO; el impuesto se calcula por línea.
 * Devuelve { kind, partnerId, items, subtotal, tax, total }.
 */
export function buildOrder({ kind, partnerId, items, taxRate = DEFAULT_TAX_RATE }) {
  if (!ORDER_KINDS.includes(kind)) throw new DomainError('Tipo de orden inválido');
  if (!partnerId) throw new DomainError('Selecciona un cliente o proveedor');
  if (!Array.isArray(items) || items.length === 0) throw new DomainError('Agrega al menos un producto');

  const rate = Number(taxRate);
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new DomainError('La tasa de impuesto es inválida');

  const lines = items.map((i) => {
    const line = {
      productId: Number(i.productId),
      quantity: Number(i.quantity),
      unitPrice: Number(i.unitPrice),
      taxRate: i.taxRate === undefined ? rate : Number(i.taxRate),
    };
    if (!line.productId) throw new DomainError('Producto inválido en una línea');
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new DomainError('La cantidad debe ser un entero mayor a 0');
    if (!(line.unitPrice >= 0)) throw new DomainError('El precio unitario es inválido');
    if (!Number.isFinite(line.taxRate) || line.taxRate < 0 || line.taxRate > 100)
      throw new DomainError('La tasa de impuesto es inválida');
    return line;
  });

  const { subtotal, tax, total } = orderTotals(lines);
  return { kind, partnerId: Number(partnerId), items: lines, subtotal, tax, total };
}
