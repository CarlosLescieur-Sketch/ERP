import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUseCases } from '../../src/application/useCases.js';
import { DomainError, NotFoundError } from '../../src/domain/errors.js';
import { makeFakeWorld } from '../helpers/fakes.js';

const product = (over = {}) => ({ id: 1, sku: 'P1', name: 'Producto', price: 10, cost: 6, stock: 100, ...over });
const customer = { id: 1, kind: 'customer', name: 'Cliente' };
const supplier = { id: 2, kind: 'supplier', name: 'Proveedor' };

const setup = (seed = {}) => {
  const world = makeFakeWorld(seed);
  const uc = makeUseCases(world);
  return { world, uc };
};

/* ---------- Productos y terceros ---------- */

test('createProduct guarda producto válido vía puerto inyectado', async () => {
  const { world, uc } = setup();
  const saved = await uc.createProduct({ sku: 'A1', name: 'Tornillo', price: 10, cost: 5, stock: 3 });
  assert.equal(saved.id, 1);
  assert.equal(world.db.products.length, 1);
});

test('createProduct propaga DomainError de validación sin tocar el puerto', async () => {
  const { world, uc } = setup();
  // buildProduct lanza de forma síncrona: envolvemos en async para que
  // assert.rejects vea una promesa (la misma ruta que recorre Express vía wrap()).
  await assert.rejects(async () => uc.createProduct({ sku: '', name: 'X', price: 1 }), DomainError);
  assert.equal(world.db.products.length, 0);
});

test('createProduct propaga 23505 (SKU duplicado)', async () => {
  const { uc } = setup({ products: [product()] });
  await assert.rejects(
    () => uc.createProduct({ sku: 'P1', name: 'Otro', price: 1 }),
    (err) => err.code === '23505');
});

test('listPartners filtra por kind', async () => {
  const { uc } = setup({ partners: [customer, supplier] });
  const onlySuppliers = await uc.listPartners('supplier');
  assert.equal(onlySuppliers.length, 1);
  assert.equal(onlySuppliers[0].name, 'Proveedor');
  assert.equal((await uc.listPartners()).length, 2);
});

/* ---------- Registro de órdenes ---------- */

test('registerSale exige cliente (no proveedor)', async () => {
  const { uc } = setup({ partners: [supplier] });
  await assert.rejects(
    () => uc.registerSale({ partnerId: 2, items: [{ productId: 1, quantity: 1, unitPrice: 10 }] }),
    DomainError);
});

test('registerPurchase exige proveedor (no cliente)', async () => {
  const { uc } = setup({ partners: [customer] });
  await assert.rejects(
    () => uc.registerPurchase({ partnerId: 1, items: [{ productId: 1, quantity: 1, unitPrice: 10 }] }),
    DomainError);
});

test('registerSale con tercero inexistente lanza NotFoundError', async () => {
  const { uc } = setup({ partners: [] });
  await assert.rejects(
    () => uc.registerSale({ partnerId: 99, items: [{ productId: 1, quantity: 1, unitPrice: 10 }] }),
    NotFoundError);
});

test('registerSale con producto inexistente lanza NotFoundError', async () => {
  const { uc } = setup({ partners: [customer], products: [] });
  await assert.rejects(
    () => uc.registerSale({ partnerId: 1, items: [{ productId: 99, quantity: 1, unitPrice: 10 }] }),
    NotFoundError);
});

test('registerSale sin stock suficiente se rechaza y no guarda nada', async () => {
  const { world, uc } = setup({
    partners: [customer],
    products: [product({ stock: 2 })],
  });
  await assert.rejects(
    () => uc.registerSale({ partnerId: 1, items: [{ productId: 1, quantity: 5, unitPrice: 10 }] }),
    /Stock insuficiente/);
  assert.equal(world.db.products[0].stock, 2); // stock intacto
  assert.equal(world.db.orders.length, 0);      // ninguna orden creada
});

test('registerSale resta stock y guarda la orden', async () => {
  const { world, uc } = setup({ partners: [customer], products: [product({ stock: 10 })] });
  const order = await uc.registerSale({
    partnerId: 1,
    items: [{ productId: 1, quantity: 3, unitPrice: 10 }],
  });
  assert.equal(order.subtotal, 30);   // neto
  assert.equal(order.tax, 4.8);       // IVA 16%
  assert.equal(order.total, 34.8);    // 30 + 4.80
  assert.equal(order.kind, 'sale');
  assert.equal(world.db.products[0].stock, 7);
  assert.equal(world.db.orders.length, 1);
});

test('registerPurchase suma stock y guarda la orden', async () => {
  const { world, uc } = setup({ partners: [supplier], products: [product({ stock: 10 })] });
  await uc.registerPurchase({
    partnerId: 2,
    items: [{ productId: 1, quantity: 5, unitPrice: 6 }],
  });
  assert.equal(world.db.products[0].stock, 15);
  assert.equal(world.db.orders[0].subtotal, 30);
  assert.equal(world.db.orders[0].tax, 4.8);
  assert.equal(world.db.orders[0].total, 34.8);
});

test('dos líneas del mismo producto acumulan stock en una compra', async () => {
  const { world, uc } = setup({ partners: [supplier], products: [product({ stock: 1 })] });
  await uc.registerPurchase({
    partnerId: 2,
    items: [
      { productId: 1, quantity: 4, unitPrice: 6 },
      { productId: 1, quantity: 6, unitPrice: 6 },
    ],
  });
  assert.equal(world.db.products[0].stock, 11);
});

test('venta sobre producto con stock insuficiente en la 2ª línea revierte la 1ª (todo o nada)', async () => {
  const { world, uc } = setup({
    partners: [customer],
    products: [product({ id: 1, stock: 10 }), product({ id: 2, sku: 'P2', stock: 1 })],
  });
  await assert.rejects(
    () => uc.registerSale({
      partnerId: 1,
      items: [
        { productId: 1, quantity: 5, unitPrice: 10 },
        { productId: 2, quantity: 99, unitPrice: 10 },
      ],
    }),
    /Stock insuficiente/);
  // La 1ª línea ya había descontado stock; la transacción lo revirtió.
  assert.equal(world.db.products[0].stock, 10);
  assert.equal(world.db.orders.length, 0);
});

/* ---------- Resumen ---------- */

test('getSummary devuelve el reporte del ReportReader inyectado', async () => {
  const summary = { sales: 100, purchases: 40, balance: 60, inventoryValue: 500, lowStock: 2 };
  const { uc } = setup({ summary });
  assert.deepEqual(await uc.getSummary(), summary);
});
