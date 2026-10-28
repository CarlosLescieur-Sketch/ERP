import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProduct } from '../../src/domain/product.js';
import { DomainError } from '../../src/domain/errors.js';

test('buildProduct normaliza y devuelve producto válido', () => {
  const p = buildProduct({ sku: ' TOR-001 ', name: ' Tornillo 1/4 ', price: 10, cost: 6, stock: 5 });
  assert.deepEqual(p, { sku: 'TOR-001', name: 'Tornillo 1/4', price: 10, cost: 6, stock: 5 });
});

test('buildProduct aplica defaults de cost y stock', () => {
  const p = buildProduct({ sku: 'X', name: 'Y', price: 1 });
  assert.equal(p.cost, 0);
  assert.equal(p.stock, 0);
});

test('buildProduct rechaza SKU o nombre vacío', () => {
  assert.throws(() => buildProduct({ sku: '', name: 'Y', price: 1 }), DomainError);
  assert.throws(() => buildProduct({ sku: 'X', name: '  ', price: 1 }), DomainError);
  assert.throws(() => buildProduct({ name: 'Y', price: 1 }), DomainError);
});

test('buildProduct rechaza precios negativos o no numéricos', () => {
  assert.throws(() => buildProduct({ sku: 'X', name: 'Y', price: -1 }), /Precio y costo/);
  assert.throws(() => buildProduct({ sku: 'X', name: 'Y', price: 1, cost: -0.01 }), /Precio y costo/);
  assert.throws(() => buildProduct({ sku: 'X', name: 'Y', price: 'abc' }), /Precio y costo/);
});

test('buildProduct rechaza stock no entero o negativo', () => {
  assert.throws(() => buildProduct({ sku: 'X', name: 'Y', price: 1, stock: -1 }), /stock/);
  assert.throws(() => buildProduct({ sku: 'X', name: 'Y', price: 1, stock: 2.5 }), /stock/);
});
