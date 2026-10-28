import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUser, can, assertPasswordStrength, publicUser, ROLES } from '../../src/domain/user.js';
import { DomainError } from '../../src/domain/errors.js';

test('buildUser normaliza correo y nombre', () => {
  const u = buildUser({ email: '  Ana@Local.Dev ', name: ' Ana García ', role: 'admin' });
  assert.deepEqual(u, { email: 'ana@local.dev', name: 'Ana García', role: 'admin', active: true });
});

test('buildUser marca inactivo cuando active !== true', () => {
  const u = buildUser({ email: 'a@b.com', name: 'X', role: 'vendedor', active: false });
  assert.equal(u.active, false);
});

test('buildUser rechaza correo sin formato, nombre vacío o rol inválido', () => {
  assert.throws(() => buildUser({ email: 'no-es-correo', name: 'X', role: 'admin' }), /formato válido/);
  assert.throws(() => buildUser({ email: 'a@b.com', name: '   ', role: 'admin' }), /nombre/);
  assert.throws(() => buildUser({ email: 'a@b.com', name: 'X', role: 'superuser' }), /Rol inválido/);
  assert.throws(() => buildUser({ email: 'a@b.com', name: 'X', role: undefined }), DomainError);
});

test('assertPasswordStrength exige mínimo 8 caracteres', () => {
  assert.throws(() => assertPasswordStrength('abc'), /8 caracteres/);
  assert.throws(() => assertPasswordStrength(12345678), /8 caracteres/);
  assert.throws(() => assertPasswordStrength(undefined), /8 caracteres/);
  assert.doesNotThrow(() => assertPasswordStrength('12345678'));
});

test('publicUser nunca expone el hash de contraseña', () => {
  const pub = publicUser({ id: 1, email: 'a@b.com', name: 'X', role: 'admin', active: true, passwordHash: 'scrypt:...', createdAt: 'hoy' });
  assert.equal(pub.passwordHash, undefined);
  assert.deepEqual(Object.keys(pub).sort(), ['active', 'createdAt', 'email', 'id', 'name', 'role']);
});

/* ---------- Matriz de permisos (la columna más importante de la Fase 1) ---------- */

test('solo admin gestiona usuarios', () => {
  for (const role of ROLES) {
    assert.equal(can(role, 'users:manage'), role === 'admin', `role=${role}`);
  }
});

test('vendedor: ventas/cotizaciones/cobros sí; inventario/compras no', () => {
  assert.equal(can('vendedor', 'sales:write'), true);
  assert.equal(can('vendedor', 'quotes:write'), true);
  assert.equal(can('vendedor', 'payments:write'), true);
  assert.equal(can('vendedor', 'partners:write'), true);
  assert.equal(can('vendedor', 'products:write'), false);
  assert.equal(can('vendedor', 'purchases:write'), false);
});

test('bodeguero: inventario/compras sí; ventas/cotizaciones no', () => {
  assert.equal(can('bodeguero', 'products:write'), true);
  assert.equal(can('bodeguero', 'purchases:write'), true);
  assert.equal(can('bodeguero', 'payments:write'), true);
  assert.equal(can('bodeguero', 'partners:write'), true);
  assert.equal(can('bodeguero', 'sales:write'), false);
  assert.equal(can('bodeguero', 'quotes:write'), false);
});

test('admin puede todo lo del sistema', () => {
  for (const p of ['users:manage', 'products:write', 'partners:write', 'purchases:write', 'sales:write', 'payments:write', 'quotes:write']) {
    assert.equal(can('admin', p), true, p);
  }
});

test('rol desconocido no tiene ningún permiso', () => {
  assert.equal(can('hacker', 'users:manage'), false);
  assert.equal(can(undefined, 'sales:write'), false);
  assert.equal(can(null, 'sales:write'), false);
});
