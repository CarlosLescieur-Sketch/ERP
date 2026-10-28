import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPartner } from '../../src/domain/partner.js';
import { DomainError } from '../../src/domain/errors.js';

test('buildPartner normaliza y devuelve tercero válido', () => {
  const p = buildPartner({ kind: 'customer', name: ' Cliente SA ', email: ' a@b.com ', phone: ' 961 ' });
  assert.deepEqual(p, { kind: 'customer', name: 'Cliente SA', email: 'a@b.com', phone: '961' });
});

test('buildPartner convierte email y phone vacíos en null', () => {
  const p = buildPartner({ kind: 'supplier', name: 'Sur', email: '', phone: '   ' });
  assert.equal(p.email, null);
  assert.equal(p.phone, null);
});

test('buildPartner rechaza tipo inválido y nombre vacío', () => {
  assert.throws(() => buildPartner({ kind: 'partner', name: 'X' }), /customer o supplier/);
  assert.throws(() => buildPartner({ kind: 'customer', name: '' }), DomainError);
  assert.throws(() => buildPartner({ name: 'X' }), DomainError);
});
