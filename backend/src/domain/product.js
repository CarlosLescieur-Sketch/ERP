import { DomainError } from './errors.js';

export function buildProduct({ sku, name, price, cost = 0, stock = 0 }) {
  if (!sku?.trim()) throw new DomainError('El SKU es obligatorio');
  if (!name?.trim()) throw new DomainError('El nombre es obligatorio');
  const p = { sku: sku.trim(), name: name.trim(), price: Number(price), cost: Number(cost), stock: Number(stock) };
  if (!(p.price >= 0) || !(p.cost >= 0)) throw new DomainError('Precio y costo deben ser números mayores o iguales a 0');
  if (!Number.isInteger(p.stock) || p.stock < 0) throw new DomainError('El stock debe ser un entero mayor o igual a 0');
  return p;
}
