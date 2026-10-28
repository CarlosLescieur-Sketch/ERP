import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildQuote, canTransition, allowedTransitions, effectiveStatus,
  assertTransition, quoteToOrderInput, QUOTE_STATUSES,
} from '../../src/domain/quote.js';
import { DomainError } from '../../src/domain/errors.js';

const line = (over = {}) => ({ productId: 1, quantity: 2, unitPrice: 10, ...over });
const quote = (over = {}) => buildQuote({ partnerId: 7, items: [line()], ...over });

/* ---------- Construcción ---------- */

test('buildQuote crea borrador con totales IVA incluido', () => {
  const q = quote({ note: '  Propuesta inicial  ' });
  assert.equal(q.status, 'draft');
  assert.equal(q.partnerId, 7);
  assert.equal(q.subtotal, 20);
  assert.equal(q.tax, 3.2);
  assert.equal(q.total, 23.2);
  assert.equal(q.note, 'Propuesta inicial'); // recortado
  assert.equal(q.expiresAt, null);
  assert.equal(q.convertedOrderId, null);
});

test('buildQuote exige cliente y al menos una línea', () => {
  assert.throws(() => buildQuote({ partnerId: 0, items: [line()] }), /cliente/);
  assert.throws(() => buildQuote({ partnerId: 1, items: [] }), /al menos un producto/);
  assert.throws(() => buildQuote({ partnerId: 1 }), /al menos un producto/);
});

test('buildQuote valida líneas igual que las órdenes', () => {
  assert.throws(() => quote({ items: [line({ quantity: 0 })] }), /entero mayor a 0/);
  assert.throws(() => quote({ items: [line({ quantity: 1.5 })] }), /entero mayor a 0/);
  assert.throws(() => quote({ items: [line({ unitPrice: -1 })] }), /unitario es inválido/);
  assert.throws(() => quote({ items: [line({ productId: 0 })] }), /Producto inválido/);
});

test('buildQuote rechaza fecha de caducidad pasada o inválida', () => {
  assert.throws(() => quote({ expiresAt: '2020-01-01' }), /futuro/);
  assert.throws(() => quote({ expiresAt: 'no-fecha' }), /no es válida/);
  const future = new Date(Date.now() + 86_400_000).toISOString();
  assert.equal(quote({ expiresAt: future }).expiresAt, future);
});

/* ---------- Máquina de estados ---------- */

test('la cadena feliz draft → sent → accepted → converted está permitida', () => {
  assert.equal(canTransition('draft', 'sent'), true);
  assert.equal(canTransition('sent', 'accepted'), true);
  assert.equal(canTransition('accepted', 'converted'), true);
});

test('los estados terminales no admiten salida', () => {
  for (const terminal of ['rejected', 'expired', 'converted']) {
    assert.deepEqual(allowedTransitions(terminal), [], terminal);
    for (const to of QUOTE_STATUSES) {
      assert.equal(canTransition(terminal, to), false, `${terminal} → ${to}`);
    }
  }
});

test('no se salta de borrador a aceptada ni se reabre una rechazada', () => {
  assert.equal(canTransition('draft', 'accepted'), false);
  assert.equal(canTransition('draft', 'converted'), false);
  assert.equal(canTransition('rejected', 'sent'), false);
  assert.equal(canTransition('converted', 'accepted'), false);
});

test('accepted no permite rechazar ni volver a enviada', () => {
  assert.equal(canTransition('accepted', 'rejected'), false);
  assert.equal(canTransition('accepted', 'sent'), false);
  assert.equal(canTransition('accepted', 'draft'), false);
});

test('assertTransition lanza DomainError con mensaje que nombra ambos estados', () => {
  assert.throws(
    () => assertTransition({ status: 'draft' }, 'accepted'),
    (err) => err instanceof DomainError
      && /Borrador/.test(err.message) && /Aceptada/.test(err.message));
  assert.throws(() => assertTransition({ status: 'draft' }, 'nonsense'), /Estado de cotización inválido/);
  // Mismo estado → también error claro (no hay transición que aplicar).
  assert.throws(() => assertTransition({ status: 'draft' }, 'draft'), /ya está en estado/);
  assert.doesNotThrow(() => assertTransition({ status: 'draft' }, 'sent'));
});

/* ---------- Caducidad perezosa ---------- */

test('effectiveStatus: enviada vencida se trata como vencida', () => {
  const past = new Date(Date.now() - 1000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();

  assert.equal(effectiveStatus({ status: 'sent', expiresAt: past }), 'expired');
  assert.equal(effectiveStatus({ status: 'sent', expiresAt: future }), 'sent');
  assert.equal(effectiveStatus({ status: 'sent', expiresAt: null }), 'sent');
  // Solo `sent` caduca: borrador o aceptada con fecha pasada conservan su estado.
  assert.equal(effectiveStatus({ status: 'draft', expiresAt: past }), 'draft');
  assert.equal(effectiveStatus({ status: 'accepted', expiresAt: past }), 'accepted');
});

test('una cotización enviada vencida no se puede aceptar', () => {
  const vencida = { status: 'sent', expiresAt: new Date(Date.now() - 1000).toISOString() };
  const vigente = { status: 'sent', expiresAt: new Date(Date.now() + 60_000).toISOString() };

  assert.throws(() => assertTransition(vencida, 'accepted'), /Vencida.*Aceptada/);
  // Marcar 'vencida' explícitamente solo vale si aún no caducó de forma perezosa
  // (si ya está efectivamente vencida, es un no-op y también se rechaza).
  assert.doesNotThrow(() => assertTransition(vigente, 'expired'));
  assert.throws(() => assertTransition(vencida, 'expired'), /ya está en estado/);
});

/* ---------- Conversión ---------- */

test('quoteToOrderInput mapea las líneas al formato de venta', () => {
  const input = quoteToOrderInput({
    partnerId: 7,
    items: [{ productId: 1, quantity: 3, unitPrice: 9.5, taxRate: 16 }],
  });
  assert.deepEqual(input, { partnerId: 7, items: [{ productId: 1, quantity: 3, unitPrice: 9.5 }] });
});

test('quoteToOrderInput falla con cotización sin líneas', () => {
  assert.throws(() => quoteToOrderInput({ partnerId: 7, items: [] }), /no tiene líneas/);
});
