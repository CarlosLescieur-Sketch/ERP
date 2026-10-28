import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTotals, orderTotals, DEFAULT_TAX_RATE } from '../../src/domain/tax.js';
import { buildOrder } from '../../src/domain/order.js';
import { DomainError } from '../../src/domain/errors.js';

test('DEFAULT_TAX_RATE es 16 (México)', () => {
  assert.equal(DEFAULT_TAX_RATE, 16);
});

test('lineTotals: IVA calculado y redondeado por línea', () => {
  assert.deepEqual(lineTotals(2, 10), { subtotal: 20, tax: 3.2, total: 23.2 });
  // Redondeo bancario por línea: 0.33 × 16% = 0.0528 → 0.05
  assert.deepEqual(lineTotals(1, 0.33), { subtotal: 0.33, tax: 0.05, total: 0.38 });
  assert.deepEqual(lineTotals(3, 19.99), { subtotal: 59.97, tax: 9.6, total: 69.57 });
  assert.deepEqual(lineTotals(1, 0, 16), { subtotal: 0, tax: 0, total: 0 });
});

test('lineTotals con tasa 0 (exento)', () => {
  assert.deepEqual(lineTotals(1, 100, 0), { subtotal: 100, tax: 0, total: 100 });
});

test('orderTotals suma líneas ya redondeadas (no recalcula sobre el total)', () => {
  // El redondeo por línea evita el descuadre clásico: 3 × 0.10 con IVA.
  const totals = orderTotals([
    { quantity: 1, unitPrice: 0.1 },
    { quantity: 1, unitPrice: 0.1 },
    { quantity: 1, unitPrice: 0.1 },
  ]);
  // Cada línea: 0.10 + 0.02 = 0.12 → tres líneas = 0.36 (no 0.30+0.048=0.35)
  assert.deepEqual(totals, { subtotal: 0.3, tax: 0.06, total: 0.36 });
});

test('orderTotals con líneas de tasa mixta', () => {
  const totals = orderTotals([
    { quantity: 1, unitPrice: 100, taxRate: 16 },
    { quantity: 1, unitPrice: 50, taxRate: 0 }, // exenta
  ]);
  assert.deepEqual(totals, { subtotal: 150, tax: 16, total: 166 });
});

test('orderTotals rechaza lista vacía o inválida', () => {
  assert.throws(() => orderTotals([]), DomainError);
  assert.throws(() => orderTotals('no'), DomainError);
});

test('el total de una orden siempre cuadra: total = subtotal + tax', () => {
  const o = buildOrder({
    kind: 'sale',
    partnerId: 1,
    items: [
      { productId: 1, quantity: 7, unitPrice: 12.34 },
      { productId: 2, quantity: 3, unitPrice: 0.99 },
      { productId: 3, quantity: 1, unitPrice: 1999.99 },
    ],
  });
  assert.equal(Math.round((o.subtotal + o.tax) * 100) / 100, o.total);
});
