// Concurrencia real: dos pagos simultáneos sobre la misma orden.
// Sin FOR UPDATE, ambos leerían el mismo saldo y sobrepagarían; con el
// bloqueo, el segundo espera al primero y relee el saldo actualizado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRepositories, makeTransactionManager,
} from '../../src/adapters/out/postgres/repositories.js';
import { makeUserRepository } from '../../src/adapters/out/postgres/authRepositories.js';
import { makeUseCases } from '../../src/application/useCases.js';
import { setupTestDb } from '../helpers/testDb.js';

const buildUserRepo = (db) => makeUserRepository(db);

let db = null;
let teardown = null;
let skip = null;
let uc;

before(async () => {
  const ctx = await setupTestDb();
  if (!ctx.pool) { skip = ctx.reason; return; }
  db = ctx.pool;
  teardown = ctx.teardown;
  const repos = buildRepositories(db);
  uc = makeUseCases({
    ...repos,
    transactions: makeTransactionManager(db),
    reports: { summary: async () => ({}) },
  });
});

after(async () => { if (teardown) await teardown(); });

const concurrency = (name, fn) => test(name, async (t) => {
  if (skip) return t.skip(skip);
  return fn(t);
});

concurrency('dos pagos simultáneos no pueden sobrepasar el saldo', async () => {
  const repos = buildRepositories(db);
  const partner = await repos.partners
    .save({ kind: 'customer', name: 'Concurrente', email: null, phone: null });
  // Usuario real: payments.created_by es FK a users.
  const user = await buildUserRepo(db).save({
    email: `conc-${Date.now()}@local.dev`, passwordHash: 'x', name: 'Conc', role: 'admin', active: true,
  });

  // Venta de 100: dos pagos de 60 lanzados a la vez solo pueden caber uno.
  const order = await repos.orders.save({
    kind: 'sale', partnerId: partner.id, subtotal: 100, tax: 0, total: 100, items: [],
  });

  const attempt = () => uc.registerSalePayment(order.id, { amount: 60, method: 'cash' }, user)
    .then(() => 'ok', (err) => err.message);

  const [a, b] = await Promise.all([attempt(), attempt()]);
  const wins = [a, b].filter((x) => x === 'ok').length;
  const losses = [a, b].filter((x) => /excede el saldo/.test(x)).length;

  assert.equal(wins, 1, `exactamente un pago debe caber (resultados: ${a} / ${b})`);
  assert.equal(losses, 1, `el otro debe rechazarse por saldo (resultados: ${a} / ${b})`);

  const detail = await repos.orders.findDetail(order.id);
  assert.equal(detail.paid, 60, 'solo se registró un pago');
  assert.equal(detail.balance, 40);
});

concurrency('cinco pagos simultáneos de 25 sobre 100: exactamente cuatro caben', async () => {
  const repos = buildRepositories(db);
  const partner = await repos.partners
    .save({ kind: 'customer', name: 'Ráfaga', email: null, phone: null });
  const user = await buildUserRepo(db).save({
    email: `rafaga-${Date.now()}@local.dev`, passwordHash: 'x', name: 'Ráfaga', role: 'admin', active: true,
  });
  const order = await repos.orders.save({
    kind: 'sale', partnerId: partner.id, subtotal: 100, tax: 0, total: 100, items: [],
  });

  const results = await Promise.all(Array.from({ length: 5 }, () =>
    uc.registerSalePayment(order.id, { amount: 25 }, user)
      .then(() => 'ok', (err) => err.message)));

  const wins = results.filter((x) => x === 'ok').length;
  assert.equal(wins, 4, `deben caber exactamente 4 de 5 (resultados: ${results.join(' | ')})`);

  const detail = await repos.orders.findDetail(order.id);
  assert.equal(detail.paid, 100);
  assert.equal(detail.balance, 0);
});
