import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrder, PARTNER_FOR } from '../../src/domain/order.js';
import { DomainError } from '../../src/domain/errors.js';

const line = (over = {}) => ({ productId: 1, quantity: 2, unitPrice: 10, ...over });

test('buildOrder calcula subtotal, IVA 16% por línea y total = subtotal + IVA', () => {
  const o = buildOrder({ kind: 'sale', partnerId: 3, items: [line(), line({ quantity: 1, unitPrice: 0.333 })] });
  // Línea 1: 2×10 = 20.00 neto → IVA 3.20
  // Línea 2: 1×0.333 = 0.33 neto (redondeado) → IVA 0.05
  assert.equal(o.subtotal, 20.33);
  assert.equal(o.tax, 3.25);
  assert.equal(o.total, 23.58); // 20.33 + 3.25
  assert.equal(o.kind, 'sale');
  assert.equal(o.partnerId, 3);
});

test('buildOrder respeta una tasa distinta de 16 (exento = 0)', () => {
  const o = buildOrder({ kind: 'sale', partnerId: 1, items: [line()], taxRate: 0 });
  assert.equal(o.subtotal, 20);
  assert.equal(o.tax, 0);
  assert.equal(o.total, 20);
});

test('buildOrder rechaza tasa fuera de rango', () => {
  assert.throws(() => buildOrder({ kind: 'sale', partnerId: 1, items: [line()], taxRate: -1 }), /tasa de impuesto/);
  assert.throws(() => buildOrder({ kind: 'sale', partnerId: 1, items: [line()], taxRate: 101 }), /tasa de impuesto/);
  assert.throws(
    () => buildOrder({ kind: 'sale', partnerId: 1, items: [{ ...line(), taxRate: 'x' }] }),
    /tasa de impuesto/);
});

test('buildOrder convierte ids y cantidades a números', () => {
  const o = buildOrder({ kind: 'purchase', partnerId: '7', items: [line({ productId: '9', quantity: '3' })] });
  assert.equal(o.partnerId, 7);
  assert.equal(o.items[0].productId, 9);
  assert.equal(o.items[0].quantity, 3);
});

test('buildOrder acepta precio unitario 0 (producto en promoción)', () => {
  const o = buildOrder({ kind: 'sale', partnerId: 1, items: [line({ unitPrice: 0 })] });
  assert.equal(o.subtotal, 0);
  assert.equal(o.tax, 0);
  assert.equal(o.total, 0);
});

test('buildOrder rechaza tipo, tercero o líneas inválidas', () => {
  assert.throws(() => buildOrder({ kind: 'invoice', partnerId: 1, items: [line()] }), /Tipo de orden/);
  assert.throws(() => buildOrder({ kind: 'sale', items: [line()] }), /cliente o proveedor/);
  assert.throws(() => buildOrder({ kind: 'sale', partnerId: 1, items: [] }), /al menos un producto/);
  assert.throws(() => buildOrder({ kind: 'sale', partnerId: 1, items: 'no' }), /al menos un producto/);
});

test('buildOrder rechaza líneas con cantidad no entera o ≤ 0', () => {
  assert.throws(() => buildOrder({ kind: 'sale', partnerId: 1, items: [line({ quantity: 0 })] }), /entero mayor a 0/);
  assert.throws(() => buildOrder({ kind: 'sale', partnerId: 1, items: [line({ quantity: 1.5 })] }), /entero mayor a 0/);
});

test('buildOrder rechaza precio unitario inválido', () => {
  assert.throws(() => buildOrder({ kind: 'sale', partnerId: 1, items: [line({ unitPrice: -1 })] }), /precio unitario/);
  assert.throws(() => buildOrder({ kind: 'sale', partnerId: 1, items: [line({ unitPrice: 'x' })] }), /precio unitario/);
});

test('PARTNER_FOR: venta→cliente, compra→proveedor', () => {
  assert.equal(PARTNER_FOR.sale, 'customer');
  assert.equal(PARTNER_FOR.purchase, 'supplier');
});
