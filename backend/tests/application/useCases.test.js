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

/* ---------- Productos: editar, borrar y archivar ---------- */

test('updateProduct cambia los datos y propaga la validación del dominio', async () => {
  const { world, uc } = setup({ products: [product()] });
  const updated = await uc.updateProduct(1, { sku: 'P1', name: 'Tornillo largo', price: 12, cost: 7, stock: 42 });
  assert.equal(updated.name, 'Tornillo largo');
  assert.equal(updated.stock, 42);
  assert.equal(world.db.products[0].name, 'Tornillo largo');

  await assert.rejects(async () => uc.updateProduct(1, { sku: 'P1', name: '', price: 1 }), DomainError);
  await assert.rejects(async () => uc.updateProduct(999, { sku: 'X', name: 'X', price: 1 }), NotFoundError);
  assert.equal(world.db.products[0].name, 'Tornillo largo'); // el fallo no tocó nada
});

test('deleteProduct borra de verdad cuando nada lo referencia', async () => {
  const { world, uc } = setup({ products: [product()] });
  const r = await uc.deleteProduct(1);
  assert.deepEqual(r, { deleted: true, id: 1 });
  assert.equal(world.db.products.length, 0);
  await assert.rejects(async () => uc.deleteProduct(999), NotFoundError);
});

test('deleteProduct archiva si está en uso por el historial (y luego no se borra, se explica)', async () => {
  const { world, uc } = setup({
    partners: [customer],
    products: [product()],
    orders: [{
      id: 1, kind: 'sale', partnerId: 1, subtotal: 10, tax: 1.6, total: 11.6,
      items: [{ productId: 1, quantity: 1, unitPrice: 10, taxRate: 16 }], createdAt: 'hoy',
    }],
  });
  const r = await uc.deleteProduct(1);
  assert.equal(r.archived, true);
  assert.equal(world.db.products.length, 1);      // sigue ahí para el historial
  assert.equal(world.db.products[0].archived, true);

  // Archivado y todavía en uso: no se borra y el motivo queda claro.
  await assert.rejects(() => uc.deleteProduct(1), /en uso/);

  // Saca del listado normal y permite ver/restaurar los archivados.
  assert.equal((await uc.listProducts()).length, 0);
  assert.equal((await uc.listProducts({ archived: true })).length, 1);
  const back = await uc.setProductArchived(1, false);
  assert.equal(back.archived, false);
  assert.equal((await uc.listProducts()).length, 1);
});

/* ---------- Terceros: editar, borrar y archivar ---------- */

test('updatePartner actualiza nombre, correo y teléfono', async () => {
  const { world, uc } = setup({ partners: [customer] });
  const updated = await uc.updatePartner(1, { kind: 'customer', name: 'Cliente Nuevo', email: 'n@x.com', phone: '555' });
  assert.equal(updated.name, 'Cliente Nuevo');
  assert.equal(world.db.partners[0].email, 'n@x.com');
  await assert.rejects(async () => uc.updatePartner(999, { kind: 'customer', name: 'X' }), NotFoundError);
});

test('updatePartner no deja cambiar el tipo si el tercero ya tiene historial', async () => {
  const { uc } = setup({
    partners: [customer],
    orders: [{
      id: 1, kind: 'sale', partnerId: 1, subtotal: 10, tax: 1.6, total: 11.6,
      items: [], createdAt: 'hoy',
    }],
  });
  await assert.rejects(
    () => uc.updatePartner(1, { kind: 'supplier', name: 'Cliente' }),
    /cambiar el tipo/);
  // ...pero sí si no tiene nada registrado.
  const { world, uc: uc2 } = setup({ partners: [customer] });
  await uc2.updatePartner(1, { kind: 'supplier', name: 'Cliente' });
  assert.equal(world.db.partners[0].kind, 'supplier');
});

test('deletePartner borra si está libre y archiva si está en uso', async () => {
  const { world, uc } = setup({
    partners: [customer, supplier],
    orders: [{
      id: 1, kind: 'sale', partnerId: 1, subtotal: 10, tax: 1.6, total: 11.6,
      items: [], createdAt: 'hoy',
    }],
  });
  // El proveedor no está en nada → se borra.
  assert.deepEqual(await uc.deletePartner(2), { deleted: true, id: 2 });
  // El cliente tiene una venta → se archiva.
  assert.deepEqual(await uc.deletePartner(1), { archived: true, id: 1 });
  assert.equal(world.db.partners.length, 1);
  assert.equal((await uc.listPartners('customer')).length, 0);
  assert.equal((await uc.listPartners('customer', { archived: true })).length, 1);
});

test('no se puede facturar a un tercero archivado', async () => {
  const { uc } = setup({
    partners: [{ ...customer, archived: true }],
    products: [product()],
  });
  await assert.rejects(
    () => uc.registerSale({ partnerId: 1, items: [{ productId: 1, quantity: 1, unitPrice: 10 }] }),
    /archivado/);
  await assert.rejects(
    () => uc.createQuote({ partnerId: 1, items: [{ productId: 1, quantity: 1, unitPrice: 10 }] }, { id: 1 }),
    /archivado/);
});

/* ---------- Órdenes: editar y borrar ---------- */

const saleOrder = (over = {}) => ({
  id: 1, kind: 'sale', partnerId: 1, subtotal: 30, tax: 4.8, total: 34.8,
  items: [{ productId: 1, quantity: 3, unitPrice: 10, taxRate: 16 }],
  createdAt: '2026-01-01', ...over,
});

test('updateSale recalcula totales y acomoda el stock por diferencia', async () => {
  const { world, uc } = setup({
    partners: [customer],
    products: [product({ stock: 10 })],
    orders: [saleOrder()],
  });
  // Venta original de 3 unidades; stock actual 10.
  const updated = await uc.updateSale(1, {
    partnerId: 1,
    items: [{ productId: 1, quantity: 5, unitPrice: 20 }],
  });
  assert.equal(updated.subtotal, 100);
  assert.equal(updated.tax, 16);
  assert.equal(updated.total, 116);
  assert.equal(updated.items[0].quantity, 5);
  // Revierte 3 (+3 → 13) y aplica 5 (−5 → 8).
  assert.equal(world.db.products[0].stock, 8);
  assert.equal(world.db.orders[0].items[0].quantity, 5);
});

test('updateSale no deja bajar el total por debajo de lo ya pagado', async () => {
  const { uc } = setup({
    partners: [customer],
    products: [product({ stock: 10 })],
    orders: [saleOrder()],
    payments: [{ id: 1, orderId: 1, amount: 30, method: 'cash', note: null, paidAt: 'hoy' }],
  });
  await assert.rejects(
    () => uc.updateSale(1, { partnerId: 1, items: [{ productId: 1, quantity: 1, unitPrice: 10 }] }),
    /no puede ser menor que lo ya pagado/);
  // ...y la orden quedó intacta.
  assert.equal((await uc.getOrder(1)).total, 34.8);
});

test('updateSale sin stock para las líneas nuevas revierte todo (todo o nada)', async () => {
  const { world, uc } = setup({
    partners: [customer],
    products: [product({ stock: 10 })],
    orders: [saleOrder()],
  });
  await assert.rejects(
    () => uc.updateSale(1, { partnerId: 1, items: [{ productId: 1, quantity: 999, unitPrice: 10 }] }),
    /Stock insuficiente/);
  assert.equal(world.db.products[0].stock, 10);                    // stock intacto
  assert.equal(world.db.orders[0].items[0].quantity, 3);           // líneas intactas
});

test('editar o borrar la orden equivocada se rechaza por tipo', async () => {
  const { uc } = setup({
    partners: [supplier],
    products: [product()],
    orders: [{ id: 7, kind: 'purchase', partnerId: 2, subtotal: 6, tax: 0.96, total: 6.96,
               items: [{ productId: 1, quantity: 1, unitPrice: 6, taxRate: 16 }], createdAt: 'hoy' }],
  });
  await assert.rejects(
    () => uc.updateSale(7, { partnerId: 1, items: [{ productId: 1, quantity: 1, unitPrice: 6 }] }),
    /no es una venta/);
  await assert.rejects(() => uc.deleteSale(7), /no es una venta/);
  await assert.rejects(async () => uc.deleteSale(999), NotFoundError);
});

test('deleteSale devuelve el stock y borra sus pagos en cascada', async () => {
  const { world, uc } = setup({
    partners: [customer],
    products: [product({ stock: 10 })],
    orders: [saleOrder()],
    payments: [{ id: 1, orderId: 1, amount: 20, method: 'cash', note: null, paidAt: 'hoy' }],
  });
  const r = await uc.deleteSale(1);
  assert.equal(r.deleted, true);
  assert.equal(world.db.orders.length, 0);
  assert.equal(world.db.payments.length, 0);   // cascada
  assert.equal(world.db.products[0].stock, 13); // 10 + 3 devueltas
});

test('deletePurchase no deja devolver unidades que ya se consumieron', async () => {
  const { world, uc } = setup({
    partners: [supplier],
    products: [product({ stock: 4 })], // la compra metió 10, pero ya se vendieron
    orders: [{ id: 2, kind: 'purchase', partnerId: 2, subtotal: 60, tax: 9.6, total: 69.6,
               items: [{ productId: 1, quantity: 10, unitPrice: 6, taxRate: 16 }], createdAt: 'hoy' }],
  });
  await assert.rejects(() => uc.deletePurchase(2), /ya fue consumido/);
  assert.equal(world.db.orders.length, 1);     // no se borró nada
  assert.equal(world.db.products[0].stock, 4); // ni se tocó el stock
});
