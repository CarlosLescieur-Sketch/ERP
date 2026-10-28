import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUseCases } from '../../src/application/useCases.js';
import { DomainError, NotFoundError } from '../../src/domain/errors.js';
import { makeFakeWorld } from '../helpers/fakes.js';

const customer = { id: 1, kind: 'customer', name: 'Cliente C' };
const supplier = { id: 2, kind: 'supplier', name: 'Proveedor P' };

const setup = (seed = {}) => {
  const world = makeFakeWorld(seed);
  return { world, uc: makeUseCases(world) };
};

const newQuote = (uc, over = {}) => uc.createQuote({
  partnerId: 1,
  items: [{ productId: 1, quantity: 2, unitPrice: 10 }],
  ...over,
}, { id: 9, name: 'Admin' });

/* ---------- Creación ---------- */

test('createQuote guarda borrador con totales y creador', async () => {
  const { world, uc } = setup({ partners: [customer], products: [{ id: 1, sku: 'P1', name: 'Prod', price: 10, cost: 5, stock: 50 }] });
  const q = await newQuote(uc);
  assert.equal(q.status, 'draft');
  assert.equal(q.statusLabel, 'Borrador');
  assert.deepEqual(q.allowed, ['sent']);
  assert.equal(q.subtotal, 20);
  assert.equal(q.tax, 3.2);
  assert.equal(q.total, 23.2);
  assert.equal(q.createdBy, 9);
  assert.equal(world.db.quotes.length, 1);
  // Cotizar NO mueve stock (no reserva inventario).
  assert.equal(world.db.products[0].stock, 50);
});

test('createQuote rechaza proveedor como cliente cotizado', async () => {
  const { uc } = setup({ partners: [supplier], products: [{ id: 1, sku: 'P1', name: 'Prod', price: 1, cost: 1, stock: 5 }] });
  await assert.rejects(() => newQuote(uc, { partnerId: 2 }), /solo para clientes/);
});

test('createQuote falla con cliente o producto inexistente', async () => {
  const { uc, world } = setup({ partners: [customer], products: [] });
  await assert.rejects(async () => newQuote(uc, { partnerId: 999 }), NotFoundError);
  await assert.rejects(async () => newQuote(uc), NotFoundError);
  assert.equal(world.db.quotes.length, 0); // nada quedó a medias
});

/* ---------- Transiciones ---------- */

test('flujo completo: crear → enviar → aceptar → convertir', async () => {
  const { world, uc } = setup({
    partners: [customer],
    products: [{ id: 1, sku: 'P1', name: 'Prod', price: 10, cost: 5, stock: 50 }],
  });
  const created = await newQuote(uc);

  const sent = await uc.transitionQuote(created.id, 'sent');
  assert.equal(sent.status, 'sent');
  assert.deepEqual(sent.allowed, ['accepted', 'rejected', 'expired']);

  const accepted = await uc.transitionQuote(created.id, 'accepted');
  assert.deepEqual(accepted.allowed, ['converted']);

  const { order, quote: converted } = await uc.convertQuoteToSale(created.id);
  assert.equal(converted.status, 'converted');
  assert.equal(converted.convertedOrderId, order.id);
  assert.equal(order.kind, 'sale');
  assert.equal(order.total, 23.2); // mismos totales que la cotización
  // El stock SÍ se descuenta al convertir (2 unidades).
  assert.equal(world.db.products[0].stock, 48);
  assert.equal(world.db.orders.length, 1);
});

test('transiciones inválidas se rechazan con mensaje claro', async () => {
  const { uc } = setup({ partners: [customer], products: [{ id: 1, sku: 'P', name: 'X', price: 1, cost: 1, stock: 9 }] });
  const q = await newQuote(uc);

  // Borrador no se puede aceptar directamente.
  await assert.rejects(async () => uc.transitionQuote(q.id, 'accepted'), /Borrador.*Aceptada/);
  // Borrador no se puede convertir.
  await assert.rejects(async () => uc.convertQuoteToSale(q.id), /Borrador.*Convertida/);
  // Estado inexistente.
  await assert.rejects(async () => uc.transitionQuote(q.id, 'volando'), /Estado de cotización inválido/);
  // Cotización inexistente.
  await assert.rejects(async () => uc.transitionQuote(404, 'sent'), NotFoundError);
});

test('aceptada no admite rechazo; rechazada es terminal', async () => {
  const { uc } = setup({ partners: [customer], products: [{ id: 1, sku: 'P', name: 'X', price: 1, cost: 1, stock: 9 }] });
  const q = await newQuote(uc);
  await uc.transitionQuote(q.id, 'sent');
  await uc.transitionQuote(q.id, 'accepted');
  await assert.rejects(async () => uc.transitionQuote(q.id, 'rejected'), /Aceptada.*Rechazada/);

  const q2 = await newQuote(uc);
  await uc.transitionQuote(q2.id, 'sent');
  await uc.transitionQuote(q2.id, 'rejected');
  await assert.rejects(async () => uc.transitionQuote(q2.id, 'sent'), /Rechazada.*Enviada/);
  await assert.rejects(async () => uc.convertQuoteToSale(q2.id), /Rechazada.*Convertida/);
});

/* ---------- Caducidad perezosa en lectura ---------- */

test('list/get muestran caducidad vencida como "Vencida" sin tocar la BD', async () => {
  const { world, uc } = setup({ partners: [customer], products: [{ id: 1, sku: 'P', name: 'X', price: 1, cost: 1, stock: 9 }] });
  const q = await newQuote(uc);
  await uc.transitionQuote(q.id, 'sent');

  // Viaja en el tiempo: fecha de caducidad ya vencida.
  world.db.quotes[0].expiresAt = new Date(Date.now() - 1000).toISOString();

  const [listed] = await uc.listQuotes();
  assert.equal(listed.status, 'expired');
  assert.equal(listed.statusLabel, 'Vencida');
  assert.deepEqual(listed.allowed, []);
  const detail = await uc.getQuote(q.id);
  assert.equal(detail.status, 'expired');
  // La BD sigue diciendo 'sent' (transición efectiva, sin cron).
  assert.equal(world.db.quotes[0].status, 'sent');
  // Y ya no se puede aceptar.
  await assert.rejects(async () => uc.transitionQuote(q.id, 'accepted'), /Vencida/);
});

test('listQuotes filtra por estado y getQuote devuelve null si no existe', async () => {
  const { uc } = setup({ partners: [customer], products: [{ id: 1, sku: 'P', name: 'X', price: 1, cost: 1, stock: 9 }] });
  const q = await newQuote(uc);
  await uc.transitionQuote(q.id, 'sent');
  assert.equal((await uc.listQuotes('sent')).length, 1);
  assert.equal((await uc.listQuotes('accepted')).length, 0);
  assert.equal(await uc.getQuote(404), null);
  assert.equal((await uc.listQuotes())[0].id, q.id);
});

/* ---------- Conversión con negocio real ---------- */

test('convertir falla si no hay stock y la cotización queda aceptada (reintentable)', async () => {
  const { world, uc } = setup({
    partners: [customer],
    products: [{ id: 1, sku: 'P1', name: 'Escaso', price: 10, cost: 5, stock: 1 }],
  });
  const q = await newQuote(uc); // pide 2, hay 1
  await uc.transitionQuote(q.id, 'sent');
  await uc.transitionQuote(q.id, 'accepted');

  await assert.rejects(() => uc.convertQuoteToSale(q.id), /Stock insuficiente/);
  // Nada se aplicó a medias: ni orden ni cambio de estado ni stock tocado.
  assert.equal(world.db.orders.length, 0);
  assert.equal(world.db.quotes[0].status, 'accepted');
  assert.equal(world.db.products[0].stock, 1);
});

test('convertir dos veces falla (ya convertida)', async () => {
  const { uc } = setup({
    partners: [customer],
    products: [{ id: 1, sku: 'P1', name: 'Prod', price: 10, cost: 5, stock: 50 }],
  });
  const q = await newQuote(uc);
  await uc.transitionQuote(q.id, 'sent');
  await uc.transitionQuote(q.id, 'accepted');
  await uc.convertQuoteToSale(q.id);
  await assert.rejects(async () => uc.convertQuoteToSale(q.id), /Convertida/);
});

test('un proveedor no puede recibir cotizaciones aunque el id exista', async () => {
  const { uc } = setup({ partners: [supplier], products: [{ id: 1, sku: 'P', name: 'X', price: 1, cost: 1, stock: 9 }] });
  await assert.rejects(() => newQuote(uc, { partnerId: 2 }), DomainError);
});
