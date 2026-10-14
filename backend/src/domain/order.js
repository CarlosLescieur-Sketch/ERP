import { DomainError } from './errors.js';

export const ORDER_KINDS = ['purchase', 'sale'];
// Una venta la hace un cliente; una compra se le hace a un proveedor.
export const PARTNER_FOR = { sale: 'customer', purchase: 'supplier' };

export function buildOrder({ kind, partnerId, items }) {
  if (!ORDER_KINDS.includes(kind)) throw new DomainError('Tipo de orden inválido');
  if (!partnerId) throw new DomainError('Selecciona un cliente o proveedor');
  if (!Array.isArray(items) || items.length === 0) throw new DomainError('Agrega al menos un producto');

  const lines = items.map((i) => {
    const line = { productId: Number(i.productId), quantity: Number(i.quantity), unitPrice: Number(i.unitPrice) };
    if (!line.productId) throw new DomainError('Producto inválido en una línea');
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) throw new DomainError('La cantidad debe ser un entero mayor a 0');
    if (!(line.unitPrice >= 0)) throw new DomainError('El precio unitario es inválido');
    return line;
  });
  const total = Math.round(lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0) * 100) / 100;
  return { kind, partnerId: Number(partnerId), items: lines, total };
}
