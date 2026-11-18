// Integración de los repositorios Postgres contra un esquema aislado.
// Si PostgreSQL no está disponible, todos los tests se saltan (skip) en
// lugar de fallar, para que `npm test` sirva también sin base de datos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRepositories, makeTransactionManager, makeReportReader,
} from '../../src/adapters/out/postgres/repositories.js';
import { makeUserRepository, makeSessionRepository } from '../../src/adapters/out/postgres/authRepositories.js';
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

/* ---------- CRUD: edición y borrado de entidades ---------- */

integration('products: update, archivar, filtrar y borrar', async () => {
  const p = await seedProduct({ stock: 5 });
  const updated = await repos.products.update({
    id: p.id, sku: p.sku, name: 'Editado', price: 12, cost: 7, stock: 9,
  });
  assert.equal(updated.name, 'Editado');
  assert.equal(updated.stock, 9);
  assert.equal(updated.archived, false);
  assert.equal(
    await repos.products.update({ id: 999999, sku: 'NO', name: 'NO', price: 1, cost: 0, stock: 0 }),
    null);

  assert.equal(await repos.products.inUse(p.id), false);
  const arch = await repos.products.setArchived(p.id, true);
  assert.equal(arch.archived, true);
  // Saca del listado normal y aparece solo en el de archivados.
  assert.equal((await repos.products.findAll()).some((x) => x.id === p.id), false);
  assert.equal((await repos.products.findAll({ archived: true })).some((x) => x.id === p.id), true);

  await repos.products.remove(p.id);
  assert.equal(await repos.products.findById(p.id), null);
});

integration('products: inUse detecta el historial y el borrado directo pega en la FK', async () => {
  const partner = await repos.partners.save({ kind: 'customer', name: 'Cliente FK', email: null, phone: null });
  const product = await seedProduct();
  const order = await repos.orders.save({
    kind: 'sale', partnerId: partner.id, subtotal: 10, tax: 1.6, total: 11.6,
    items: [{ productId: product.id, quantity: 1, unitPrice: 10, taxRate: 16 }],
  });

  assert.equal(await repos.products.inUse(product.id), true);
  // Sin el chequeo previo, la BD responde con violación de llave foránea.
  await assert.rejects(() => repos.products.remove(product.id), (err) => err.code === '23503');

  // Borrar la orden libera el producto (y borra sus líneas en cascada).
  await repos.orders.remove(order.id);
  assert.equal(await repos.products.inUse(product.id), false);
});

integration('partners: update, archivar, filtrar y borrar', async () => {
  const c = await repos.partners.save({ kind: 'customer', name: 'Cliente CRUD', email: null, phone: null });
  const updated = await repos.partners.update({
    id: c.id, kind: 'customer', name: 'Editado', email: 'e@x.com', phone: '555',
  });
  assert.equal(updated.name, 'Editado');
  assert.equal(updated.email, 'e@x.com');
  assert.equal(
    await repos.partners.update({ id: 999999, kind: 'customer', name: 'X', email: null, phone: null }),
    null);

  assert.equal(await repos.partners.inUse(c.id), false);
  await repos.partners.setArchived(c.id, true);
  assert.equal((await repos.partners.findAll('customer')).some((p) => p.id === c.id), false);
  assert.equal((await repos.partners.findAll('customer', { archived: true })).some((p) => p.id === c.id), true);

  await repos.partners.remove(c.id);
  assert.equal(await repos.partners.findById(c.id), null);
});

integration('partners: inUse es true con una orden y el borrado directo pega en la FK', async () => {
  const partner = await repos.partners.save({ kind: 'customer', name: 'Cliente Uso', email: null, phone: null });
  const order = await repos.orders.save({
    kind: 'sale', partnerId: partner.id, subtotal: 5, tax: 0.8, total: 5.8, items: [],
  });
  assert.equal(await repos.partners.inUse(partner.id), true);
  await assert.rejects(() => repos.partners.remove(partner.id), (err) => err.code === '23503');
  await repos.orders.remove(order.id);
  assert.equal(await repos.partners.inUse(partner.id), false);
});

integration('orders: update cambia la cabecera y replaceItems reemplaza las líneas', async () => {
  const partner = await repos.partners.save({ kind: 'customer', name: 'Cliente E', email: null, phone: null });
  const p1 = await seedProduct();
  const p2 = await seedProduct();
  const order = await repos.orders.save({
    kind: 'sale', partnerId: partner.id, subtotal: 20, tax: 3.2, total: 23.2,
    items: [{ productId: p1.id, quantity: 2, unitPrice: 10, taxRate: 16 }],
  });

  const items = await repos.orders.findItems(order.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].productId, p1.id);
  assert.equal(items[0].quantity, 2);

  assert.equal(await repos.orders.update({
    id: order.id, partnerId: partner.id, subtotal: 30, tax: 4.8, total: 34.8,
  }) !== null, true);
  assert.equal(await repos.orders.update({
    id: 999999, partnerId: partner.id, subtotal: 0, tax: 0, total: 0,
  }), null);
  await repos.orders.replaceItems(order.id, [
    { productId: p2.id, quantity: 3, unitPrice: 10, taxRate: 16 },
    { productId: p1.id, quantity: 1, unitPrice: 5, taxRate: 16 },
  ]);

  const detail = await repos.orders.findDetail(order.id);
  assert.equal(Number(detail.total), 34.8);
  assert.equal(detail.items.length, 2);
  assert.equal(detail.items[0].productId, p2.id);
  assert.equal(detail.items[1].quantity, 1);
});

integration('orders: remove borra líneas y pagos en cascada', async () => {
  const partner = await repos.partners.save({ kind: 'customer', name: 'Cliente B', email: null, phone: null });
  const product = await seedProduct();
  const order = await repos.orders.save({
    kind: 'sale', partnerId: partner.id, subtotal: 10, tax: 1.6, total: 11.6,
    items: [{ productId: product.id, quantity: 1, unitPrice: 10, taxRate: 16 }],
  });
  await repos.orders.savePayment(order.id, { amount: 5, method: 'cash', note: null }, null);

  await repos.orders.remove(order.id);
  assert.equal(await repos.orders.findDetail(order.id), null);
  const [{ n: items }] = (await db.query('SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1', [order.id])).rows;
  const [{ n: pays }] = (await db.query('SELECT COUNT(*)::int AS n FROM payments WHERE order_id = $1', [order.id])).rows;
  assert.equal(items, 0);
  assert.equal(pays, 0);
});

integration('orders: findPayment, updatePayment y removePayment', async () => {
  const partner = await repos.partners.save({ kind: 'customer', name: 'Cliente P', email: null, phone: null });
  const order = await repos.orders.save({
    kind: 'sale', partnerId: partner.id, subtotal: 100, tax: 16, total: 116, items: [],
  });
  const saved = await repos.orders.savePayment(order.id, { amount: 40, method: 'cash', note: 'Inicial' }, null);

  const found = await repos.orders.findPayment(saved.id);
  assert.equal(found.orderId, order.id);
  assert.equal(found.amount, 40);
  assert.equal(await repos.orders.findPayment(999999), null);

  await repos.orders.updatePayment(saved.id, { amount: 66, method: 'transfer', note: 'Corregido' });
  assert.equal(await repos.orders.paidByOrder(order.id), 66);
  const updated = await repos.orders.findPayment(saved.id);
  assert.equal(updated.method, 'transfer');
  assert.equal(updated.note, 'Corregido');

  await repos.orders.removePayment(saved.id);
  assert.equal(await repos.orders.paidByOrder(order.id), 0);
});

integration('quotes: update cambia cabecera y líneas; remove borra en cascada', async () => {
  const partner = await repos.partners.save({ kind: 'customer', name: 'Cliente Q', email: null, phone: null });
  const p1 = await seedProduct();
  const p2 = await seedProduct();
  const quote = await repos.quotes.save({
    partnerId: partner.id, status: 'draft', subtotal: 20, tax: 3.2, total: 23.2,
    note: null, expiresAt: null, convertedOrderId: null, createdBy: null,
    items: [{ productId: p1.id, quantity: 2, unitPrice: 10, taxRate: 16 }],
  });

  const updated = await repos.quotes.update({
    id: quote.id, partnerId: partner.id, subtotal: 30, tax: 4.8, total: 34.8,
    note: 'Editada', expiresAt: null,
    items: [{ productId: p2.id, quantity: 3, unitPrice: 10, taxRate: 16 }],
  });
  assert.equal(Number(updated.total), 34.8);
  assert.equal(await repos.quotes.update({ id: 999999, partnerId: partner.id, subtotal: 0, tax: 0, total: 0, note: null, expiresAt: null, items: [] }), null);

  const detail = await repos.quotes.findById(quote.id);
  assert.equal(detail.note, 'Editada');
  assert.equal(detail.items.length, 1);
  assert.equal(detail.items[0].productId, p2.id);
  // La cabecera no pierde estado ni conversión.
  assert.equal(detail.status, 'draft');
  assert.equal(detail.createdBy, null);

  await repos.quotes.remove(quote.id);
  assert.equal(await repos.quotes.findById(quote.id), null);
  const [{ n }] = (await db.query('SELECT COUNT(*)::int AS n FROM quote_items WHERE quote_id = $1', [quote.id])).rows;
  assert.equal(n, 0);
});

integration('users: remove borra el usuario y sus sesiones (cascada)', async () => {
  const users = makeUserRepository(db);
  const sessions = makeSessionRepository(db);
  const u = await users.save({
    email: `u-${Date.now()}@local.dev`, passwordHash: 'x', name: 'Temporal',
    role: 'vendedor', active: true,
  });
  const token = await sessions.create(u.id, 1);
  assert.ok(await sessions.findByToken(token));

  await users.remove(u.id);
  assert.equal(await users.findById(u.id), null);
  assert.equal(await sessions.findByToken(token), null); // sesiones en cascada
  assert.equal(
    await users.update({ id: 999999, email: 'x@y.co', name: 'X', role: 'admin', active: true, passwordHash: 'x' }),
    null);
});
