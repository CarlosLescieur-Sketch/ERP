// Integración del lector de reportes: SQL real del dashboard contra la BD
// aislada. Si PostgreSQL no está disponible, los tests se saltan (skip).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildRepositories, makeReportReader } from '../../src/adapters/out/postgres/repositories.js';
import { setupTestDb } from '../helpers/testDb.js';

let db = null;
let teardown = null;
let skip = null;
let repos;
let reports;

before(async () => {
  const ctx = await setupTestDb();
  if (!ctx.pool) { skip = ctx.reason; return; }
  db = ctx.pool;
  teardown = ctx.teardown;
  repos = buildRepositories(db);
  reports = makeReportReader(db);
});

after(async () => { if (teardown) await teardown(); });

const integration = (name, fn) => test(name, async (t) => {
  if (skip) return t.skip(skip);
  return fn(t);
});

integration('dashboard: sin datos devuelve la estructura con series en 0', async () => {
  // Este test corre primero: la BD de pruebas está recién migrada y vacía.
  const d = await reports.dashboard(3);
  assert.equal(d.monthly.length, 3);
  assert.ok(d.monthly.every((r) => r.sales === 0 && r.purchases === 0 && r.collected === 0));
  assert.deepEqual(d.topProducts, []);
  assert.deepEqual(d.topCustomers, []);
  assert.deepEqual(d.paymentMethods, []);
  assert.deepEqual(d.quoteStatuses, []);
  assert.equal(d.summary.sales, 0);
  assert.equal(d.summary.receivable, 0);
});

integration('dashboard: serie mensual continua con meses vacíos en 0', async () => {
  const partner = await repos.partners
    .save({ kind: 'customer', name: 'Cliente Dash', email: null, phone: null });
  const a = await repos.products.save({ sku: 'DASH-A', name: 'Producto A', price: 10, cost: 5, stock: 99 });
  const b = await repos.products.save({ sku: 'DASH-B', name: 'Producto B', price: 20, cost: 8, stock: 99 });

  // Dos ventas y una compra en el mes actual.
  const sale1 = await repos.orders.save({
    kind: 'sale', partnerId: partner.id, subtotal: 20, tax: 3.2, total: 23.2,
    items: [{ productId: a.id, quantity: 2, unitPrice: 10, taxRate: 16 }],
  });
  await repos.orders.save({
    kind: 'sale', partnerId: partner.id, subtotal: 60, tax: 9.6, total: 69.6,
    items: [{ productId: b.id, quantity: 3, unitPrice: 20, taxRate: 16 }],
  });
  await repos.orders.save({
    kind: 'purchase', partnerId: partner.id, subtotal: 30, tax: 4.8, total: 34.8,
    items: [{ productId: a.id, quantity: 5, unitPrice: 6, taxRate: 16 }],
  });

  // Cobros parciales sobre la primera venta (10 + 13.2 = 23.2, la salda).
  await repos.orders.savePayment(sale1.id, { amount: 10, method: 'cash', note: null }, null);
  await repos.orders.savePayment(sale1.id, { amount: 13.2, method: 'transfer', note: null }, null);

  const d = await reports.dashboard(6);

  // La ventana es continua: 6 meses, sin huecos.
  assert.equal(d.monthly.length, 6);
  assert.equal(d.months, 6);
  for (const row of d.monthly) assert.match(row.month, /^\d{4}-\d{2}$/);

  // El mes actual (el último de la serie) cuadra con lo sembrado.
  const current = d.monthly.at(-1);
  assert.equal(current.sales, 92.8, 'ventas del mes');
  assert.equal(current.purchases, 34.8, 'compras del mes');
  assert.equal(current.salesCount, 2);
  assert.equal(current.collected, 23.2, 'cobrado del mes');

  // Los meses anteriores a la actividad quedan en 0 (relleno).
  const empty = d.monthly.slice(0, -1);
  assert.ok(empty.length >= 5);
  assert.ok(empty.every((r) => r.sales === 0 && r.purchases === 0 && r.collected === 0));

  // Rankings dentro de la ventana.
  assert.deepEqual(d.topProducts.map((p) => p.sku), ['DASH-B', 'DASH-A']); // 60 > 20
  assert.equal(d.topProducts[0].revenue, 60);
  assert.equal(d.topProducts[0].units, 3);
  assert.equal(d.topCustomers[0].name, 'Cliente Dash');
  assert.equal(d.topCustomers[0].total, 92.8);
  assert.equal(d.topCustomers[0].orders, 2);

  // Métodos de cobro agrupados.
  assert.deepEqual(
    Object.fromEntries(d.paymentMethods.map((m) => [m.method, m.total])),
    { transfer: 13.2, cash: 10 });

  // Los KPIs del dashboard coinciden con GET /api/summary.
  assert.equal(d.summary.sales, 92.8);
  assert.equal(d.summary.receivable, 69.6); // 92.8 − 23.2 cobrados
  assert.equal(d.summary.payable, 34.8);    // compra sin pagar

  // Estado de cotizaciones (estado actual, fuera de la ventana temporal).
  await repos.quotes.save({
    partnerId: partner.id, status: 'draft', subtotal: 10, tax: 1.6, total: 11.6,
    note: null, expiresAt: null, convertedOrderId: null, createdBy: null,
    items: [{ productId: a.id, quantity: 1, unitPrice: 10, taxRate: 16 }],
  });
  const d2 = await reports.dashboard(12);
  assert.equal(d2.quoteStatuses.find((q) => q.status === 'draft')?.count, 1);
  assert.equal(d2.monthly.length, 12);
  // Con más ventana, el mes actual sigue cuadrando (los datos son los mismos).
  assert.equal(d2.monthly.at(-1).sales, 92.8);
});
