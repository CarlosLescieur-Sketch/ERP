import { buildProduct } from '../domain/product.js';
import { buildPartner } from '../domain/partner.js';
import { buildOrder, PARTNER_FOR } from '../domain/order.js';
import { DomainError, NotFoundError } from '../domain/errors.js';

// Cada caso de uso recibe sus puertos por inyección (ver main.js).
export function makeUseCases({ products, partners, orders, reports, transactions }) {
  const registerOrder = (kind) => (input) => {
    const order = buildOrder({ ...input, kind });
    // Todo o nada: la orden y el movimiento de inventario van en una sola transacción.
    return transactions.run(async (tx) => {
      const partner = await tx.partners.findById(order.partnerId);
      if (!partner) throw new NotFoundError('El cliente/proveedor no existe');
      if (partner.kind !== PARTNER_FOR[kind])
        throw new DomainError(`Esta operación requiere un ${PARTNER_FOR[kind] === 'customer' ? 'cliente' : 'proveedor'}`);

      for (const line of order.items) {
        const product = await tx.products.findById(line.productId, { lock: true });
        if (!product) throw new NotFoundError(`Producto ${line.productId} no existe`);
        if (kind === 'sale' && product.stock < line.quantity)
          throw new DomainError(`Stock insuficiente de "${product.name}" (disponible: ${product.stock})`);
        await tx.products.adjustStock(line.productId, kind === 'sale' ? -line.quantity : line.quantity);
      }
      return tx.orders.save(order);
    });
  };

  return {
    listProducts: () => products.findAll(),
    createProduct: (input) => products.save(buildProduct(input)),
    listPartners: (kind) => partners.findAll(kind),
    createPartner: (input) => partners.save(buildPartner(input)),
    listPurchases: () => orders.findAll('purchase'),
    listSales: () => orders.findAll('sale'),
    registerPurchase: registerOrder('purchase'),
    registerSale: registerOrder('sale'),
    getSummary: () => reports.summary(),
  };
}
