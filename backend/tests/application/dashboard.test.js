import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUseCases } from '../../src/application/useCases.js';
import { makeFakeWorld } from '../helpers/fakes.js';

const seed = {
  partners: [{ id: 1, kind: 'customer', name: 'Cliente A' }],
  products: [
    { id: 1, sku: 'A', name: 'Producto A', price: 10, cost: 5, stock: 9 },
    { id: 2, sku: 'B', name: 'Producto B', price: 20, cost: 8, stock: 9 },
  ],
  orders: [
    { id: 1, kind: 'sale', partnerId: 1, subtotal: 20, tax: 3.2, total: 23.2, createdAt: '2026-10-01',
      items: [{ productId: 1, quantity: 2, unitPrice: 10 }] },
    { id: 2, kind: 'sale', partnerId: 1, subtotal: 60, tax: 9.6, total: 69.6, createdAt: '2026-10-02',
      items: [{ productId: 2, quantity: 3, unitPrice: 20 }] },
  ],
  payments: [
    { id: 1, orderId: 1, amount: 10, method: 'cash', note: null, paidAt: '2026-10-03' },
    { id: 2, orderId: 1, amount: 13.2, method: 'transfer', note: null, paidAt: '2026-10-04' },
  ],
  quotes: [
    { id: 1, status: 'draft', partnerId: 1, items: [], total: 10 },
    { id: 2, status: 'sent', partnerId: 1, items: [], total: 20 },
  ],
  summary: { sales: 92.8, purchases: 0, balance: 92.8, inventoryValue: 117, lowStock: 1, receivable: 69.6, payable: 0 },
};

const setup = () => {
  const world = makeFakeWorld(seed);
  return { world, uc: makeUseCases(world) };
};

test('getDashboard devuelve la estructura completa con los datos agregados', async () => {
  const { uc } = setup();
  const d = await uc.getDashboard({ months: 6 });

  assert.equal(d.months, 6);
  // Los KPIs llegan igual que en /api/summary.
  assert.equal(d.summary.sales, 92.8);
  assert.equal(d.summary.receivable, 69.6);
  assert.deepEqual(d.monthly, []); // la serie la cubre el test de integración

  // Top productos por ingresos: B (60) antes que A (20).
  assert.deepEqual(d.topProducts.map((p) => p.name), ['Producto B', 'Producto A']);
  assert.equal(d.topProducts[0].revenue, 60);
  assert.equal(d.topProducts[0].units, 3);
  assert.equal(d.topProducts[1].revenue, 20);

  // Top clientes: uno solo, con ambas ventas.
  assert.equal(d.topCustomers.length, 1);
  assert.equal(d.topCustomers[0].name, 'Cliente A');
  assert.equal(d.topCustomers[0].total, 92.8);
  assert.equal(d.topCustomers[0].orders, 2);

  // Métodos de cobro ordenados por monto: transferencia (13.2) > efectivo (10).
  assert.deepEqual(d.paymentMethods.map((m) => m.method), ['transfer', 'cash']);
  assert.equal(d.paymentMethods[0].total, 13.2);
  assert.equal(d.paymentMethods[0].count, 1);

  // Cotizaciones por estado.
  assert.deepEqual(
    Object.fromEntries(d.quoteStatuses.map((q) => [q.status, q.count])),
    { draft: 1, sent: 1 });
});

test('sanea el periodo: fuera de rango o no numérico cae a valores seguros', async () => {
  const { uc } = setup();
  assert.equal((await uc.getDashboard({ months: 'x' })).months, 12);
  assert.equal((await uc.getDashboard({ months: undefined })).months, 12);
  assert.equal((await uc.getDashboard()).months, 12);
  assert.equal((await uc.getDashboard({ months: 0 })).months, 3);   // mínimo
  assert.equal((await uc.getDashboard({ months: -40 })).months, 3);
  assert.equal((await uc.getDashboard({ months: 999 })).months, 24); // máximo
  assert.equal((await uc.getDashboard({ months: 6.7 })).months, 6);  // entero
});
