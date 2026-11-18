import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUseCases } from '../../src/application/useCases.js';
import { DomainError, NotFoundError } from '../../src/domain/errors.js';
import { buildPayment } from '../../src/domain/payment.js';
import { makeFakeWorld } from '../helpers/fakes.js';

const customer = { id: 1, kind: 'customer', name: 'Cliente' };
const supplier = { id: 2, kind: 'supplier', name: 'Proveedor' };

const setup = (seed = {}) => {
  const world = makeFakeWorld(seed);
  return { world, uc: makeUseCases(world) };
};

// Una venta de 116 (subtotal 100 + IVA 16) sin pagar.
const saleSeed = (over = {}) => ({
  partners: [customer],
  orders: [{
    id: 1, kind: 'sale', partnerId: 1, subtotal: 100, tax: 16, total: 116,
    items: [{ productId: 1, quantity: 4, unitPrice: 25, taxRate: 16 }],
    createdAt: '2026-01-01', ...over,
  }],
});

/* ---------- buildPayment (dominio) ---------- */

test('buildPayment valida monto y método', () => {
  assert.deepEqual(buildPayment({ amount: '50.5', method: 'card' }), { amount: 50.5, method: 'card', note: null });
  assert.deepEqual(buildPayment({ amount: 10 }), { amount: 10, method: 'cash', note: null });
  assert.deepEqual(buildPayment({ amount: 0.005 }), { amount: 0.01, method: 'cash', note: null }); // redondeo
  assert.throws(() => buildPayment({ amount: 0 }), /mayor a 0/);
  assert.throws(() => buildPayment({ amount: -5 }), /mayor a 0/);
  assert.throws(() => buildPayment({ amount: 'x' }), /mayor a 0/);
  assert.throws(() => buildPayment({ amount: 10, method: 'bitcoin' }), /Método de pago inválido/);
});

test('buildPayment recorta nota vacía a null', () => {
  assert.equal(buildPayment({ amount: 10, note: '   ' }).note, null);
  assert.equal(buildPayment({ amount: 10, note: ' anticipo ' }).note, 'anticipo');
});

/* ---------- registerSalePayment (caso de uso) ---------- */

test('registrar un pago parcial devuelve el saldo restante', async () => {
  const { uc } = setup(saleSeed());
  const result = await uc.registerSalePayment(1, { amount: 40, method: 'cash' }, { id: 9 });
  assert.equal(result.amount, 40);
  assert.equal(result.balance, 76); // 116 − 40
  assert.equal(result.createdById, 9); // queda registrado quién cobró
});

test('pagos sucesivos acumulan hasta saldar', async () => {
  const { world, uc } = setup(saleSeed());
  await uc.registerSalePayment(1, { amount: 100 }, { id: 1 });
  const last = await uc.registerSalePayment(1, { amount: 16 }, { id: 1 });
  assert.equal(last.balance, 0);
  assert.equal(world.db.payments.length, 2);
  assert.equal(await world.orders.paidByOrder(1), 116);
});

test('no se admite sobrepago: excede el saldo pendiente', async () => {
  const { world, uc } = setup(saleSeed());
  await uc.registerSalePayment(1, { amount: 100 }, { id: 1 });
  await assert.rejects(
    () => uc.registerSalePayment(1, { amount: 16.01 }, { id: 1 }),
    /excede el saldo pendiente \(16\.00\)/);
  assert.equal(world.db.payments.length, 1); // el intento no dejó rastro
});

test('pago exacto al saldo completo es válido (hasta el centavo)', async () => {
  const { uc } = setup(saleSeed());
  const r = await uc.registerSalePayment(1, { amount: 116 }, { id: 1 });
  assert.equal(r.balance, 0);
});

test('pago sobre orden inexistente → NotFoundError', async () => {
  const { uc } = setup(saleSeed());
  await assert.rejects(async () => uc.registerSalePayment(404, { amount: 10 }, { id: 1 }), NotFoundError);
  await assert.rejects(async () => uc.registerSalePayment('abc', { amount: 10 }, { id: 1 }), NotFoundError);
});

test('un pago de venta no se puede registrar sobre una compra', async () => {
  const { uc } = setup({
    partners: [supplier],
    orders: [{ id: 5, kind: 'purchase', partnerId: 2, subtotal: 50, tax: 8, total: 58, items: [], createdAt: 'hoy' }],
  });
  await assert.rejects(() => uc.registerSalePayment(5, { amount: 10 }, { id: 1 }), /corresponde a/);
  // ...pero sí con el caso de uso de compras.
  const r = await uc.registerPurchasePayment(5, { amount: 10 }, { id: 1 });
  assert.equal(r.balance, 48);
});

test('monto inválido se rechaza antes de tocar la transacción', async () => {
  const { world, uc } = setup(saleSeed());
  await assert.rejects(async () => uc.registerSalePayment(1, { amount: 0 }, { id: 1 }), DomainError);
  await assert.rejects(async () => uc.registerSalePayment(1, { amount: -1 }, { id: 1 }), DomainError);
  assert.equal(world.db.payments.length, 0);
});

test('el resumen expone por cobrar y por pagar', async () => {
  const { uc } = setup({ summary: { sales: 0, purchases: 0, balance: 0, inventoryValue: 0, lowStock: 0, receivable: 1234.5, payable: 678.9 } });
  const s = await uc.getSummary();
  assert.equal(s.receivable, 1234.5);
  assert.equal(s.payable, 678.9);
});

/* ---------- getOrder ---------- */

test('getOrder devuelve el detalle o null si no existe', async () => {
  const { uc } = setup(saleSeed());
  const order = await uc.getOrder(1);
  assert.equal(order.partner, 'Cliente');
  assert.equal(order.total, 116);
  assert.equal(order.balance, 116);
  assert.equal(await uc.getOrder(999), null);
});

/* ---------- Edición y borrado de pagos ---------- */

const paidSeed = (payments, over = {}) => ({
  ...saleSeed(),
  payments: payments.map((p, i) => ({ id: i + 1, orderId: 1, method: 'cash', note: null, paidAt: 'hoy', ...p })),
  ...over,
});

test('updatePayment cambia monto y método y devuelve el saldo nuevo', async () => {
  const { world, uc } = setup(paidSeed([{ amount: 40 }]));
  const r = await uc.updateSalePayment(1, 1, { amount: 60, method: 'transfer', note: 'Revisión' });
  assert.equal(r.amount, 60);
  assert.equal(r.method, 'transfer');
  assert.equal(r.balance, 56); // 116 − 60
  assert.equal(world.db.payments[0].amount, 60);
  assert.equal(world.db.payments[0].method, 'transfer');
});

test('updatePayment no admite exceder el saldo (contando los demás pagos)', async () => {
  const { world, uc } = setup(paidSeed([{ amount: 40 }, { amount: 50 }]));
  // Pagado 90; editar el de 40 deja disponibles 116 − 50 = 66.
  await assert.rejects(
    () => uc.updateSalePayment(1, 1, { amount: 66.01 }),
    /excede el saldo pendiente \(66\.00\)/);
  assert.equal(world.db.payments[0].amount, 40); // el fallo no tocó nada

  const ok = await uc.updateSalePayment(1, 1, { amount: 66 });
  assert.equal(ok.balance, 0); // 66 + 50 = 116 → saldada
});

test('updatePayment de un pago ajeno a la orden → NotFoundError', async () => {
  const { uc } = setup(paidSeed([{ amount: 40 }]));
  await assert.rejects(async () => uc.updateSalePayment(1, 999, { amount: 10 }), NotFoundError);
  await assert.rejects(
    async () => uc.updatePurchasePayment(1, 1, { amount: 10 }),
    /no es una compra/);
});

test('deletePayment borra el pago y recalcula el saldo', async () => {
  const { world, uc } = setup(paidSeed([{ amount: 40 }, { amount: 50 }]));
  const r = await uc.deleteSalePayment(1, 1);
  assert.equal(r.deleted, true);
  assert.equal(r.balance, 66); // 116 − 50
  assert.equal(world.db.payments.length, 1);
  assert.equal(await world.orders.paidByOrder(1), 50);

  await assert.rejects(async () => uc.deleteSalePayment(1, 999), NotFoundError);
});
