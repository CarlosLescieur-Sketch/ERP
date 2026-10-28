// Integración de los repositorios Postgres contra un esquema aislado.
// Si PostgreSQL no está disponible, todos los tests se saltan (skip) en
// lugar de fallar, para que `npm test` sirva también sin base de datos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRepositories, makeTransactionManager, makeReportReader,
} from '../../src/adapters/out/postgres/repositories.js';
import { runMigrations } from '../../src/adapters/out/postgres/migrate.js';
import { setupTestDb } from '../helpers/testDb.js';

let db = null;
let teardown = null;
let skip = null;
let repos;
let transactions;
let reports;

before(async () => {
  const ctx = await setupTestDb();
  if (!ctx.pool) { skip = ctx.reason; return; }
  db = ctx.pool;
  teardown = ctx.teardown;
  repos = buildRepositories(db);
  transactions = makeTransactionManager(db);
  reports = makeReportReader(db);
});

after(async () => { if (teardown) await teardown(); });

// Envuelve un test: si no hay BD, se salta con `skip`.
const integration = (name, fn) => test(name, async (t) => {
  if (skip) return t.skip(skip);
  return fn(t);
});

const seedProduct = (over = {}) => repos.products.save({
  sku: `SKU-${Math.random().toString(36).slice(2, 8)}`, name: 'Prod', price: 10, cost: 6, stock: 10, ...over,
});

integration('migraciones: schema_migrations registra 001_init.sql', async () => {
  const { rows } = await db.query('SELECT version FROM schema_migrations');
  assert.ok(rows.some((r) => r.version === '001_init.sql'), 'falta 001_init.sql en schema_migrations');
});

integration('migraciones: re-ejecutar es idempotente', async () => {
  await runMigrations(db); // no debe lanzar ni duplicar registros
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM schema_migrations');
  const { rows: all } = await db.query("SELECT COUNT(*)::int AS n FROM schema_migrations WHERE version = '001_init.sql'");
  assert.equal(all[0].n, 1);
  assert.ok(rows[0].n >= 1);
});

integration('products: guardar, buscar y ajustar stock', async () => {
  const p = await seedProduct({ stock: 5 });
  const found = await repos.products.findById(p.id);
  assert.equal(found.sku, p.sku);
  assert.equal(found.price, 10);

  await repos.products.adjustStock(p.id, -3);
  assert.equal((await repos.products.findById(p.id)).stock, 2);

  const missing = await repos.products.findById(999999);
  assert.equal(missing, null);
});

integration('products: SKU duplicado lanza error 23505', async () => {
  await seedProduct();
  const dup = await repos.products.save({ sku: (await repos.products.findAll())[0].sku, name: 'X', price: 1, cost: 0, stock: 0 })
    .then(() => null, (err) => err);
  assert.equal(dup?.code, '23505');
});

integration('products: findById con lock usa FOR UPDATE (bloqueo dentro de transacción)', async () => {
  await seedProduct();
  // Dentro de la transacción el lock debe funcionar; fuera lanzaría error de sintaxis.
  const ok = await transactions.run((tx) => tx.products.findById(1, { lock: true }));
  assert.ok(ok, 'FOR UPDATE dentro de transacción debe funcionar');
});

integration('partners: findAll filtra por kind', async () => {
  const c = await repos.partners.save({ kind: 'customer', name: 'Cliente X', email: null, phone: null });
  await repos.partners.save({ kind: 'supplier', name: 'Proveedor Y', email: null, phone: null });
  assert.ok((await repos.partners.findAll('customer')).some((p) => p.id === c.id));
  assert.equal((await repos.partners.findAll('supplier')).length, 1);
});

integration('orders: guardar orden con líneas y listar unidades', async () => {
  const partner = await repos.partners.save({ kind: 'customer', name: 'Cliente O', email: null, phone: null });
  const product = await seedProduct();
  const order = await repos.orders.save({
    kind: 'sale', partnerId: partner.id, subtotal: 20, tax: 3.2, total: 23.2,
    items: [{ productId: product.id, quantity: 2, unitPrice: 10, taxRate: 16 }],
  });
  assert.ok(order.id > 0);

  const list = await repos.orders.findAll('sale');
  const row = list.find((o) => o.id === order.id);
  assert.ok(row, 'la orden debe aparecer en el listado');
  assert.equal(Number(row.total), 23.2);
  assert.equal(Number(row.subtotal), 20);
  assert.equal(Number(row.tax), 3.2);
  assert.equal(row.units, 2);
  assert.equal(row.partner, 'Cliente O');
  assert.equal(Number(row.paid), 0);
  assert.equal(Number(row.balance), 23.2); // saldo = total − pagado
});

integration('orders: findDetail devuelve líneas, pagos y saldo calculado', async () => {
  const partner = await repos.partners.save({ kind: 'customer', name: 'Cliente D', email: null, phone: null });
  const product = await seedProduct();
  const order = await repos.orders.save({
    kind: 'sale', partnerId: partner.id, subtotal: 100, tax: 16, total: 116,
    items: [{ productId: product.id, quantity: 4, unitPrice: 25, taxRate: 16 }],
  });

  // Orden inexistente → null (el HTTP lo traduce a 404).
  assert.equal(await repos.orders.findDetail(999999), null);

  let detail = await repos.orders.findDetail(order.id);
  assert.equal(detail.partner, 'Cliente D');
  assert.equal(detail.partnerKind, 'customer');
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0].sku, product.sku);
  assert.equal(detail.items[0].taxRate, 16);
  assert.deepEqual(detail.payments, []);
  assert.equal(detail.paid, 0);
  assert.equal(detail.balance, 116);

  await repos.orders.savePayment(order.id, { amount: 50, method: 'transfer', note: 'Anticipo' }, null);
  detail = await repos.orders.findDetail(order.id);
  assert.equal(detail.paid, 50);
  assert.equal(detail.balance, 66);
  assert.equal(detail.payments[0].method, 'transfer');
  assert.equal(detail.payments[0].note, 'Anticipo');
  assert.equal(await repos.orders.paidByOrder(order.id), 50);
});

integration('orders: findById con lock bloquea la fila (FOR UPDATE)', async () => {
  const partner = await repos.partners.save({ kind: 'customer', name: 'Cliente L', email: null, phone: null });
  const order = await repos.orders.save({
    kind: 'sale', partnerId: partner.id, subtotal: 10, tax: 1.6, total: 11.6, items: [],
  });
  // Dentro de transacción debe funcionar; fuera lanzaría error.
  const locked = await transactions.run((tx) => tx.orders.findById(order.id, { lock: true }));
  assert.equal(locked.id, order.id);
  assert.equal(locked.total, 11.6);
});

integration('transacciones: COMMIT persiste y ROLLBACK deshace', async () => {
  const partner = await repos.partners.save({ kind: 'customer', name: 'Cliente T', email: null, phone: null });

  await transactions.run(async (tx) => {
    await tx.orders.save({ kind: 'sale', partnerId: partner.id, subtotal: 5, tax: 0, total: 5, items: [] });
  });
  const committed = await db.query('SELECT COUNT(*)::int AS n FROM orders WHERE total = 5');
  assert.equal(committed.rows[0].n, 1, 'el COMMIT debe persistir la orden');

  await assert.rejects(
    transactions.run(async (tx) => {
      await tx.orders.save({ kind: 'sale', partnerId: partner.id, subtotal: 7, tax: 0, total: 7, items: [] });
      throw new Error('falla deliberada');
    }),
    /falla deliberada/);
  const rolled = await db.query('SELECT COUNT(*)::int AS n FROM orders WHERE total = 7');
  assert.equal(rolled.rows[0].n, 0, 'el ROLLBACK debe deshacer la orden');
});

integration('reports: summary calcula sobre los datos reales', async () => {
  const s = await reports.summary();
  assert.ok(typeof s.sales === 'number');
  assert.ok(typeof s.purchases === 'number');
  assert.equal(s.balance, s.sales - s.purchases);
  assert.ok(s.inventoryValue >= 0);
  assert.ok(s.lowStock >= 0);
});
