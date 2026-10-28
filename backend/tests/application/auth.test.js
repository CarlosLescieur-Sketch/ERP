import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUseCases } from '../../src/application/useCases.js';
import { DomainError, UnauthorizedError } from '../../src/domain/errors.js';
import { makeFakeWorld } from '../helpers/fakes.js';

const admin = { id: 1, email: 'admin@local.dev', name: 'Admin', role: 'admin', active: true, passwordHash: 'fake:Admin123!' };
const seller = { id: 2, email: 'vend@local.dev', name: 'Vende', role: 'vendedor', active: true, passwordHash: 'fake:Vend12345' };
const disabled = { id: 3, email: 'off@local.dev', name: 'Off', role: 'vendedor', active: false, passwordHash: 'fake:Algo1234' };

const setup = (seed = {}) => {
  const world = makeFakeWorld(seed);
  const uc = makeUseCases(world);
  return { world, uc };
};

/* ---------- Login ---------- */

test('login con credenciales válidas devuelve token y usuario público', async () => {
  const { uc } = setup({ users: [admin] });
  const { token, user } = await uc.login({ email: 'ADMIN@local.dev', password: 'Admin123!' });
  assert.match(token, /^fake-token-/);
  assert.equal(user.email, 'admin@local.dev');
  assert.equal(user.role, 'admin');
  assert.equal(user.passwordHash, undefined); // nunca se filtra
});

test('login normaliza el correo (mayúsculas y espacios)', async () => {
  const { uc } = setup({ users: [admin] });
  const { user } = await uc.login({ email: '  Admin@Local.Dev  ', password: 'Admin123!' });
  assert.equal(user.email, 'admin@local.dev');
});

test('login con contraseña incorrecta → UnauthorizedError (no distingue de correo inexistente)', async () => {
  const { uc, world } = setup({ users: [admin] });
  await assert.rejects(() => uc.login({ email: 'admin@local.dev', password: 'mala' }), UnauthorizedError);
  await assert.rejects(
    () => uc.login({ email: 'nadie@local.dev', password: 'mala' }),
    (err) => {
      assert.ok(err instanceof UnauthorizedError);
      // Mismo mensaje en ambos casos: no se revela si el correo existe.
      return err.message === 'Credenciales inválidas';
    });
  assert.equal(world.db.sessions.length, 0); // ninguna sesión creada
});

test('login con usuario inactivo → UnauthorizedError', async () => {
  const { uc } = setup({ users: [disabled] });
  await assert.rejects(() => uc.login({ email: 'off@local.dev', password: 'Algo1234' }), UnauthorizedError);
});

test('login sin correo o sin contraseña → DomainError (400)', async () => {
  const { uc } = setup({ users: [admin] });
  await assert.rejects(() => uc.login({ email: '', password: 'x' }), DomainError);
  await assert.rejects(() => uc.login({ email: 'a@b.com', password: '' }), DomainError);
  await assert.rejects(() => uc.login({}), DomainError);
});

/* ---------- Sesión ---------- */

test('sessionUser devuelve el usuario con token válido y null sin token', async () => {
  const { uc } = setup({ users: [admin] });
  const { token } = await uc.login({ email: 'admin@local.dev', password: 'Admin123!' });
  const me = await uc.sessionUser(token);
  assert.equal(me.email, 'admin@local.dev');
  assert.equal(await uc.sessionUser(undefined), null);
  assert.equal(await uc.sessionUser('token-inventado'), null);
});

test('logout borra la sesión: sessionUser deja de resolver', async () => {
  const { uc } = setup({ users: [admin] });
  const { token } = await uc.login({ email: 'admin@local.dev', password: 'Admin123!' });
  await uc.logout(token);
  assert.equal(await uc.sessionUser(token), null);
});

test('sessionUser no devuelve usuarios inactivos aunque tengan sesión válida', async () => {
  const world = makeFakeWorld({ users: [{ ...disabled }] });
  const uc = makeUseCases(world);
  // Sesión creada manualmente (simula que el usuario fue desactivado después del login).
  world.db.sessions.push({ token: 'tok-activa', userId: 3, expiresAt: Date.now() + 60_000 });
  assert.equal(await uc.sessionUser('tok-activa'), null);
});

/* ---------- Usuarios (admin) ---------- */

test('listUsers no expone hashes de contraseña', async () => {
  const { uc } = setup({ users: [admin, seller] });
  const list = await uc.listUsers();
  assert.equal(list.length, 2);
  for (const u of list) assert.equal(u.passwordHash, undefined);
});

test('createUser hashea la contraseña y guarda el usuario', async () => {
  const { uc, world } = setup({ users: [] });
  const created = await uc.createUser(
    { email: 'Nueva@Local.Dev', name: 'Nueva', role: 'bodeguero', password: 'Secreta123' },
    admin);
  assert.equal(created.email, 'nueva@local.dev');
  assert.equal(created.passwordHash, undefined);
  const stored = world.db.users[0];
  assert.equal(stored.passwordHash, 'fake:Secreta123'); // hasheado por el puerto inyectado
  assert.equal(stored.role, 'bodeguero');
});

test('createUser rechaza contraseña corta, rol inválido y correo duplicado', async () => {
  const { uc } = setup({ users: [admin] });
  await assert.rejects(
    () => uc.createUser({ email: 'x@y.com', name: 'X', role: 'admin', password: 'corto' }, admin),
    /8 caracteres/);
  await assert.rejects(
    () => uc.createUser({ email: 'x@y.com', name: 'X', role: 'root', password: 'Larga1234' }, admin),
    /Rol inválido/);
  await assert.rejects(
    () => uc.createUser({ email: 'admin@local.dev', name: 'Dup', role: 'admin', password: 'Larga1234' }, admin),
    /Ya existe un usuario/);
});

test('changePassword exige la contraseña actual y valida la nueva', async () => {
  const { uc, world } = setup({ users: [admin] });
  await assert.rejects(
    () => uc.changePassword({ currentPassword: 'mala', newPassword: 'Nueva12345' }, { id: 1 }),
    UnauthorizedError);
  await assert.rejects(
    () => uc.changePassword({ currentPassword: 'Admin123!', newPassword: 'corto' }, { id: 1 }),
    /8 caracteres/);

  const ok = await uc.changePassword({ currentPassword: 'Admin123!', newPassword: 'Nueva12345' }, { id: 1 });
  assert.deepEqual(ok, { ok: true });
  assert.equal(world.db.users[0].passwordHash, 'fake:Nueva12345');

  // La contraseña vieja ya no sirve.
  await assert.rejects(() => uc.login({ email: 'admin@local.dev', password: 'Admin123!' }), UnauthorizedError);
});
