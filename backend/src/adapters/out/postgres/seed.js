// Crea (o repara) el usuario administrador inicial.
//   npm run seed                     → usa ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME del .env
//   npm run seed -- --email a@b.c --password Secreta123 --name "Nombre"
// Idempotente: si el correo ya existe, solo actualiza contraseña y nombre.
import { parseArgs } from 'node:util';
import { pool } from './pool.js';
import { makeUserRepository } from './authRepositories.js';
import { passwords } from '../crypto/passwords.js';
import { buildUser, assertPasswordStrength } from '../../../domain/user.js';

const { values } = parseArgs({
  options: {
    email: { type: 'string' },
    password: { type: 'string' },
    name: { type: 'string' },
  },
});

const email = values.email ?? process.env.ADMIN_EMAIL ?? 'admin@local.dev';
const password = values.password ?? process.env.ADMIN_PASSWORD;
const name = values.name ?? process.env.ADMIN_NAME ?? 'Administrador';

if (!password) {
  console.error('Falta la contraseña: pasa --password o define ADMIN_PASSWORD en backend/.env');
  process.exit(1);
}
assertPasswordStrength(password);

const users = makeUserRepository(pool);
const user = buildUser({ email, name, role: 'admin', active: true });
const passwordHash = await passwords.hash(password);

const existing = await users.findByEmail(user.email);
if (existing) {
  await users.update({ ...existing, passwordHash, active: true });
  console.log(`Usuario admin actualizado: ${user.email} (contraseña restablecida)`);
} else {
  await users.save({ ...user, passwordHash });
  console.log(`Usuario admin creado: ${user.email}`);
}

await pool.end();
